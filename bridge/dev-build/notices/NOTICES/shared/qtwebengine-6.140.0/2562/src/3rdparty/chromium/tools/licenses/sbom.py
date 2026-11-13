# Create an SBOM document for target

# Usage: see sbom.py --help

import os
import sys
import json
import argparse
import collections
import dataclasses
import licenses as license_tools
from typing import Any, Callable, DefaultDict, Tuple
import spdx_writer
import pathlib
import subprocess
import datetime
import logging
import re

logger = logging.getLogger(__name__)

# <webengine-root>/src/3rdparty/chromium
ROOT = license_tools._REPOSITORY_ROOT

# Field name used in README.chromium files -> SPDX JSON schema name
CHROMIUM_TO_SPDX_KEY = {
    'Version': 'versionInfo',
    'URL': 'homepage',
    'Source Info': 'sourceInfo',
    'Comment': 'comment',
}

# third_party/README.chromium.template says to use the string
# "This is the canonical public repository." to mark projects that don't
# have a homepage. Not all READMEs follow the text exactly, so just
# match against the first words.
CANONICAL_HOMEPAGE_STRING = "This is the canonical"

# Packages that have bad homepages that don't start with CANONICAL_HOMEPAGE_STRING
PACKAGES_TO_CLEAN_BAD_URL = [
    'psm (private set membership) client side',
]

# Some packages don't have a license file, but their license is a known SPDX
# identifier so we can still use it.
OVERRIDE_LICENSE_FILE_METADATA_KEY = "Override License File"
PACKAGES_TO_OVERRIDE_LICENSE_FILE_WITH_ID = [
    'libdrm',
    'mini_chromium',
    'temporal_rs',
    'temporal_capi',
    'timezone_provider',
    'unicode-ident',
]

# Command to find the first "Baseline" git commit in src/3rdparty
FIND_BASELINE_COMMIT_GIT_COMMAND = \
  ['git', 'rev-list', '-n1', '--first-parent', '--grep=^BASELINE: Update Chromium', 'HEAD', '--', '.']

# Hardcoded metadata for GN
GN_BASE_METADATA = {
    'Id': 'GN',
    'Name': 'GN',
    'Description': 'GN is a meta-build system that generates build files for Ninja.',
    'URL': 'https://gn.googlesource.com/gn',
    'LicenseId': 'BSD-3-Clause',
    'License': 'BSD 3-clause \"New\" or \"Revised\" License',
    'LicenseFile': 'LICENSE',
    'Copyright': 'Copyright 2015 The Chromium Authors. All rights reserved.'
}

DIRECTORIES_TO_SKIP_BECAUSE_THEY_HAVE_VARIOUS_PARSING_ISSUES = [
    # Missing README.chromium and/or license
    os.path.join('third_party', 'catapult'),
    os.path.join('third_party', 'crashpad', 'crashpad', 'third_party', 'lss'),
    os.path.join('third_party', 'crashpad', 'crashpad', 'third_party', 'zlib'),
    os.path.join('third_party', 'devtools-frontend', 'src', 'front_end', 'third_party', 'chromium'),
    os.path.join('third_party', 'perfetto', 'protos', 'third_party', 'chromium'),
    os.path.join('third_party', 'rust'),
    os.path.join('third_party', 'tflite'),
]

# Wrappers for Chromium's package and SPDX writer tools
@dataclasses.dataclass(frozen=True)
class ExtendedPackage(spdx_writer._Package):
  extra_metadata: DefaultDict[str, Any]


class ExtendedSpdxJsonWriter(spdx_writer._SPDXJSONWriter):
  def __init__(self, root: str, root_package: ExtendedPackage, link_prefix: str,
               doc_name: str, doc_namespace: str):
    read_file = lambda x: pathlib.Path(x).read_text(encoding='utf-8')
    super().__init__(root, root_package, link_prefix, doc_name, doc_namespace, read_file)
    # Fixup top-level fields
    iso_time = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).strftime('%Y-%m-%dT%H:%M:%SZ')
    self.content['creationInfo']['created'] = iso_time
    self.content['creationInfo']['comment'] = "Created with src/3rdparty/chromium/tools/licenses/sbom.py as part of the QtWebEngine build system"
    self.content['spdxVersion'] = 'SPDX-2.3'

  def add_package(self, pkg: ExtendedPackage):
    # super().add_package() adds everything as a dependency of the root package, we want to set
    # up our dependencies more precisely.
    pkg_id = self._get_package_id(pkg)
    if OVERRIDE_LICENSE_FILE_METADATA_KEY in pkg.extra_metadata:
      logger.info("Allowing known license ID without file for package %s" % (pkg.name))
      license_id = pkg.file
      need_to_add_license = False
    else:
      license_id, need_to_add_license = self._get_license_id(pkg)

    # Required fields
    pkg_content = {
        'SPDXID': pkg_id,
        'name': pkg.name,
        'licenseConcluded': license_id,
        'downloadLocation': 'NOASSERTION',
        'copyrightText': 'NOASSERTION',
        'licenseDeclared': 'NOASSERTION',
    }

    # Optional metadata that may be in README.chromium
    for metadata_name, json_name in CHROMIUM_TO_SPDX_KEY.items():
      if metadata_name in pkg.extra_metadata:
        pkg_content[json_name] = pkg.extra_metadata[metadata_name]

    # Add non CPE 2.2/2.3 info as a comment, since it is not all in the correct format
    if 'CpeSpdxType' in pkg.extra_metadata:
      pkg_content['externalRefs'] = [ {
        'referenceCategory': 'SECURITY',
        'referenceType' : pkg.extra_metadata['CpeSpdxType'],
        'referenceLocator':  pkg.extra_metadata['CpeString']
      } ]
    elif 'CpeComment' in pkg.extra_metadata:
      comment = pkg.extra_metadata['CpeComment']
      if 'comment' in pkg_content:
        comment = pkg_content['comment'] + '\n' + comment
      pkg_content['comment'] = comment

    self.content['packages'].append(pkg_content)
    if need_to_add_license:
      self._add_license_file(pkg, license_id)

    return pkg_id

  def add_dependency(self, parent_id, child_id):
    self.content['relationships'].append({
      'spdxElementId': parent_id,
      'relationshipType': 'CONTAINS',
      'relatedSpdxElement': child_id,
    })

  def add_tool_package(self, tool_pkg: ExtendedPackage):
    tool_pkg_id = self.add_package(tool_pkg)
    self.add_dependency(self.root_package_id, tool_pkg_id)

class _CdxJsonWriter():
  """Writes CDX data in JSON format.

  """

  def __init__(self, root: str, root_package: spdx_writer._Package, link_prefix: str,
               doc_name: str, doc_namespace: str, author_name: str,
               author_url: str, read_file: Callable[[str], str]):
    self.root = root
    self.root_package_id = root_package.package_spdx_id
    self.link_prefix = link_prefix

    self.read_file = read_file

    self.content = {
        'bomFormat': 'CycloneDX',
        'specVersion': '1.6',
        '$schema': 'http://cyclonedx.org/schema/bom-1.6.schema.json',
        'version': 1,
        'metadata' : {
          'authors': [ { 'name' : 'Google' }, { 'name' : author_name } ],
          'component': {
            'name': doc_name,
            'bom-ref': self.root_package_id,
            'type': 'framework',
          },
          'tools': {
            'components': [],
          },
          'supplier': {
            'name': author_name,
            'url': [ author_url ],
          },
          'manufacturer': {
            'name': author_name,
            'url': [ author_url ],
          },
        },
        'dependencies': [],
        'components': [],
    }

    # Used to make sure that there are no duplicate ids.
    self.existing_package_ids = collections.defaultdict(int)  # 'packageId': num
    self.existing_license_ids = collections.defaultdict(int)  # 'licenseId': num

    # Add the root package to make sure that its ID isn't taken.
    self.add_package(root_package)

  def write(self) -> str:
    """Returns a JSON string for the current state of the writer."""
    return json.dumps(self.content, indent=4)

  def _get_dedup_id(self, elem_id: str, id_dict: DefaultDict[str, int]) -> str:
    """Returns a unique id given a dictionary with existing ids.

    IDs are case sensitive, so this method ignores casing for uniqueness.

    Args:
      elem_id: the requested id to use for the element.
      id_dict: dictionary holding already used ids.

    Returns:
      When the elem_id is already unique, return elem_id.
      When the elem_id has been used, return elem_id + '-[next num]'.
    """
    suffix = id_dict[elem_id]
    id_dict[elem_id] += 1
    return f'{elem_id}-{suffix}' if suffix > 0 else elem_id

  def _get_package_id(self, pkg: spdx_writer._Package) -> str:
    """Makes sure that there are no pkg id duplicates."""
    return self._get_dedup_id(pkg.package_spdx_id, self.existing_package_ids)

  def _get_license_id(self, pkg: spdx_writer._Package) -> Tuple[str, bool]:
    """Handles license deduplication.

    If there are two packages with the same name but different license files,
    handle deduping the names.
    """
    license_id = self._get_dedup_id(pkg.license_spdx_id,
                                    self.existing_license_ids)
    return license_id

  def add_package(self, pkg: spdx_writer._Package):
    """Writes a package to the file (package metadata)."""
    pkg_id = self._get_package_id(pkg)
    if OVERRIDE_LICENSE_FILE_METADATA_KEY in pkg.extra_metadata:
      logger.info("Allowing known license ID without file for package %s" % (pkg.name))
      # The filename is an SPDX license expression
      license_entry = {
          'acknowledgement': 'concluded',
          'expression': pkg.file
      }
    else:
      license_id = self._get_license_id(pkg)
      license_entry = { 'license': {
          'acknowledgement': 'concluded',
          'name': license_id,
          'text': { 'content': self.read_file(pkg.file) },
      }}

    pkg_content = {
        'bom-ref': pkg_id,
        'name': pkg.name,
        'type': 'library',
        'licenses': [ license_entry ],
    }

    if 'Version' in pkg.extra_metadata:
      pkg_content['version'] = pkg.extra_metadata['Version']
    if 'URL' in pkg.extra_metadata:
      url = pkg.extra_metadata['URL']
      pkg_content['externalReferences'] = [ { 'url': url, 'type': 'website' } ]
    if 'CpeString' in pkg.extra_metadata:
      pkg_content['cpe'] = pkg.extra_metadata['CpeString']

    pedigree_notes = []
    if 'Comment' in pkg.extra_metadata:
      pedigree_notes.append(pkg.extra_metadata['Comment'])
    if 'Source Info' in pkg.extra_metadata:
      pedigree_notes.append(pkg.extra_metadata['Source Info'])
    if 'CpeComment' in pkg.extra_metadata:
      pedigree_notes.append(pkg.extra_metadata['CpeComment'])

    if pedigree_notes:
      pkg_content['pedigree'] = { 'notes': '\n'.join(pedigree_notes) }

    self.content['components'].append(pkg_content)

    return pkg_id

  def add_dependency(self, parent_id, child_id):
    self.content['dependencies'].append({
        'ref': parent_id,
        'dependsOn' : [
          child_id,
        ]
    })

  def add_tool_package(self, tool_pkg: ExtendedPackage):
    tool_pkg_id = self.add_package(tool_pkg)
    self.content['metadata']['tools']['components'].append({
      'name' : tool_pkg.name,
      'type' : 'application',
      'version' : tool_pkg.extra_metadata['Version']
    })

class ExtendedCdxJsonWriter(_CdxJsonWriter):
  def __init__(self, root: str, root_package: ExtendedPackage, link_prefix: str,
               doc_name: str, doc_namespace: str):
    read_file = lambda x: pathlib.Path(x).read_text(encoding='utf-8')
    author_name = 'TheQtCompany'
    author_url = 'https://qt.io'
    super().__init__(root, root_package, link_prefix, doc_name, doc_namespace, author_name, author_url, read_file)

CACHED_BASELINE = None

def GetBaselineCommit(d):
  global CACHED_BASELINE
  if not CACHED_BASELINE:
    git_rev_list_result = subprocess.check_output(
        FIND_BASELINE_COMMIT_GIT_COMMAND,
        cwd=ROOT,
        encoding='utf-8')
    CACHED_BASELINE = git_rev_list_result.strip()
  return CACHED_BASELINE

CACHED_COMMIT_LOG = None

def GetDirectoryRevisionInfo(baseline_commit, d):
  global CACHED_COMMIT_LOG
  if not CACHED_COMMIT_LOG:
    git_log_result = subprocess.check_output(
        ['git', 'log', '--oneline', f'{baseline_commit}..HEAD', '--name-only', '--', '.'],
        cwd=ROOT,
        encoding='utf-8')
    # Split on hashes to get each commit in a separate array element
    CACHED_COMMIT_LOG = re.split('^(?=[a-fA-F0-9]{4})', git_log_result, flags=re.MULTILINE)

  num_revisions = 0
  for entry in CACHED_COMMIT_LOG:
    if ('\nchromium/' + d) in entry:
      num_revisions += 1

  if num_revisions == 0:
    return ''
  plural = '' if num_revisions == 1 else 's'
  comment_text = f'{num_revisions} revision{plural} added by Qt'
  return comment_text


def CleanupLicenseMetadata(dep_metadata):
  num_licenses = len(dep_metadata['License File'])
  if dep_metadata['Name'] in PACKAGES_TO_OVERRIDE_LICENSE_FILE_WITH_ID:
    logger.info("Using known license ID and ignoring license file(s) for package %s" % (dep_metadata['Name']))

    dep_metadata['License File'] = dep_metadata['License']
    dep_metadata[OVERRIDE_LICENSE_FILE_METADATA_KEY] = True
  elif num_licenses == 1:
    dep_metadata['License File'] = dep_metadata['License File'][0]
  elif num_licenses == 2 and dep_metadata['License'].endswith(", Patent"):
    # Handle cases like libaom, libwebp: We don't want to include the patent file
    former_license = dep_metadata['License']
    updated_license = dep_metadata['License'][:-len(", Patent")]
    logger.info("Patent file detected for package %s, skipping patent" % (dep_metadata['Name']))
    dep_metadata['License'] = updated_license

    dep_metadata['License File'] = dep_metadata['License File'][0]
  else:
    dep_metadata['License File'] = None
    raise license_tools.LicenseError("Dependency has %d licenses, expected exactly 1" % num_licenses)


def CleanupCpeMetadata(dep_metadata):
  # Transform 'CPEPrefix' field into something usable. One of:
  # - actual CPE -> fields 'CpeString' + 'CpeSpdxType'
  # - when it cannot be used, CPE-related comment -> 'CpeComment'
  cpe_prefix = dep_metadata.get('CPEPrefix', None)
  if not cpe_prefix:
    return

  if cpe_prefix.startswith('cpe:2.3:'):
    dep_metadata['CpeSpdxType'] = 'cpe23Type'
    dep_metadata['CpeString'] = cpe_prefix
  elif cpe_prefix.startswith('cpe:/'):
    dep_metadata['CpeSpdxType'] = 'cpe22Type'
    dep_metadata['CpeString'] = cpe_prefix
  elif cpe_prefix == 'unknown':
    dep_metadata['CpeComment'] = "Chromium authors declared this package to have an unknown CPE"
  else:
    assert False, f'Invalid cpe value: {cpe_prefix}'
    dep_metadata['CpeComment'] = (
        "Chromium authors declared this package to have the CPE prefix '%s'" % cpe)


def IsChromiumSubmoduleGitHistoryAvailable():
  baseline_cmd_result = subprocess.run(
      FIND_BASELINE_COMMIT_GIT_COMMAND,
      cwd=ROOT,
      capture_output=True,
      encoding='utf-8')
  return baseline_cmd_result.returncode == 0 and baseline_cmd_result.stdout.strip()


def GetTargetMetadatas(gn_binary: str, gn_out_dir: str, gn_target: str):
  optional_keys = list(CHROMIUM_TO_SPDX_KEY.keys()) + ['Short Name', 'CPEPrefix']

  prev_cwd = os.getcwd()
  os.chdir(gn_out_dir)
  third_party_dirs = license_tools.FindThirdPartyDeps(gn_binary, gn_out_dir, gn_target, True, 'all')
  os.chdir(prev_cwd)

  # If src/3rdparty is not a git repo, skip adding revision info since it would fail on trying
  # to invoke git.
  can_include_git_info = IsChromiumSubmoduleGitHistoryAvailable()
  if not can_include_git_info:
    logger.warning("Could not find git history for '%s', git revision info will be missing" % os.path.join(ROOT, '..'))
  else:
    baseline_commit = GetBaselineCommit('.')

  metadatas = {}
  for d in third_party_dirs:
    if d in DIRECTORIES_TO_SKIP_BECAUSE_THEY_HAVE_VARIOUS_PARSING_ISSUES:
      logger.info("Skipping '%s' because it has known parsing issue" % d)
      continue
    try:
      dir_metadata, errors = license_tools.ParseDir(d, ROOT,
                                                    require_license_file=True,
                                                    enable_warnings=True,
                                                    optional_keys=optional_keys)
      if not dir_metadata:
        logger.warning("Parsing '%s' returned nothing" % d)
      metadatas[d] = dir_metadata
      git_revision_info = GetDirectoryRevisionInfo(baseline_commit, d) if can_include_git_info else None
      for dep_metadata in dir_metadata:
        CleanupLicenseMetadata(dep_metadata)
        CleanupCpeMetadata(dep_metadata)

        if git_revision_info:
          dep_metadata['Source Info'] = git_revision_info
        dep_metadata['Comment'] = f'Location within source: {d}'
        # Prefer short name when available as the full name might have spaces/punctuation and
        # be quite long.
        if 'Short Name' in dep_metadata:
          dep_metadata['Name'] = dep_metadata['Short Name']
        dep_metadata['Name'] = dep_metadata['Name'].lower()
        if dep_metadata['Name'] in PACKAGES_TO_CLEAN_BAD_URL or CANONICAL_HOMEPAGE_STRING in dep_metadata['URL']:
          logger.info("Cleaning bad URL from package: %s" % dep_metadata['Name'])
          del dep_metadata['URL']
    except license_tools.LicenseError as err:
      logger.error("Failed parsing '%s': %s" % (d, err))
      pass
    except Exception as err:
      logger.error("Failed parsing '%s': %s" % (d, err))
      pass
    license_tools.LogParseDirErrors(errors)

  return metadatas


def CreateSbomText(targets_and_metadatas, writer_type, package_id: str, doc_namespace: str, gn_version: str):
  root_license = os.path.join(ROOT, 'LICENSE')
  root = os.path.dirname(ROOT)
  link_prefix = ''
  doc_name = package_id

  def make_pkg_name(s):
    return 'QtWebEngine-Chromium-' + package_id + '-' + s

  root_pkg = ExtendedPackage(make_pkg_name("Internal-Components"), root_license, {})
  writer = writer_type(root, root_pkg, link_prefix, doc_name, doc_namespace)

  already_added_packages = dict()
  for top_level_target, metadatas in targets_and_metadatas:

    assert top_level_target[0] == ':'
    top_level_pkg_id = writer.add_package(ExtendedPackage(make_pkg_name(top_level_target[1:]), root_license, {}))
    writer.add_dependency(writer.root_package_id, top_level_pkg_id)

    for directory in sorted(metadatas):
      dir_metadata = metadatas[directory]
      for dep_metadata in dir_metadata:
        license_file = dep_metadata.pop('License File')
        # This is used in CleanupLicenseMetadata as a sentinel to skip an
        # errored-out dependency.
        if license_file is None:
          continue

        child_pkg_name = make_pkg_name(dep_metadata.pop('Name'))
        child_pkg_key = directory + ':' + child_pkg_name
        if child_pkg_key not in already_added_packages:
          child_pkg_id = writer.add_package(ExtendedPackage(child_pkg_name, license_file, dep_metadata))
          already_added_packages[child_pkg_key] = child_pkg_id
        writer.add_dependency(top_level_pkg_id, already_added_packages[child_pkg_key])

  # Manually add GN package
  gn_license = os.path.join(os.path.dirname(ROOT), 'gn', 'LICENSE')
  gn_metadata = GN_BASE_METADATA.copy()
  gn_metadata['Version'] = gn_version
  gn_name = make_pkg_name('GN')
  gn_pkg = ExtendedPackage(gn_name, gn_license, gn_metadata)
  writer.add_tool_package(gn_pkg)

  return writer.write()


def GetSbomWriterType(sbom_format, output_file):
  """Heuristically detects format from optional passed format and output file extension
  """
  if sbom_format:
    if sbom_format == 'CYDX_V1_6':
      return ExtendedCdxJsonWriter
    elif sbom_format == 'SPDX_V2_JSON':
      return ExtendedSpdxJsonWriter

    print(f"Unknown SBOM format: {sbom_format}")
    sys.exit(1)

  if output_file.endswith('.cdx.json'):
    return ExtendedCdxJsonWriter
  elif output_file.endswith('.spdx.json'):
    return ExtendedSpdxJsonWriter

  logging.warning(f"SBOM format autodetect from SBOM extension failed, "
                   "defaulting to SPDX JSON: {output_file}")
  return ExtendedSpdxJsonWriter


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument('--gn-target-list', required=True, help='Semicolon-separated list of GN targets to scan for dependencies.')
  parser.add_argument('--build-dir-list', required=True,
                      help='Semicolon-separated list of build directories corresponding to the targets in --gn-target-list')
  parser.add_argument('--gn-binary', required=True, help="GN binary location.")
  parser.add_argument('--gn-version', required=True, help="GN version.")
  parser.add_argument('--package-id', required=True, help="Camelcase package id. This is used for several purposes")
  parser.add_argument('--namespace', required=True, help="Namespace of the document")
  parser.add_argument('--sbom-format', required=False, help="SBOM format. One of SPDX_V2_JSON, CYDX_V1_6. Optional, defaults to detection based on filename extension and SPDX if unknown.")
  parser.add_argument('--verbose', action="store_true", help="Verbose output")
  parser.add_argument('output_file')
  args = parser.parse_args()

  logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING)
  logger.info("sbom.py run with arguments: %s" % (' '.join(sys.argv)))
  gn_target_list = args.gn_target_list.split(';')
  build_dir_list = args.build_dir_list.split(';')
  if len(gn_target_list) != len(build_dir_list):
    print("Number of targets must match number of build directories (%s, %s)" % (gn_target_list, build_dir_list))
    sys.exit(1)

  targets_and_metadatas = [(t, GetTargetMetadatas(args.gn_binary, b, t)) for b, t in zip(build_dir_list, gn_target_list)]

  writer_type = GetSbomWriterType(args.sbom_format, args.output_file)
  sbom_text = CreateSbomText(targets_and_metadatas, writer_type, args.package_id, args.namespace, args.gn_version)

  with open(args.output_file, 'w', encoding='utf-8') as f:
    f.write(sbom_text)

if __name__ == '__main__':
  sys.exit(main())
