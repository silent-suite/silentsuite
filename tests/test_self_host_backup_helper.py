"""Static contracts for the self-host backup helper and the docs around it.

The bug these guard against is specific and was shipped: documentation printed
`docker run -v self-host_server_data:/data ... tar czf ...`. Docker creates a
missing named volume silently, so on any install whose Compose project name is
not `self-host` that command archives a brand-new empty volume and reports
success. The fix is not a better guess — manual installs and
`COMPOSE_PROJECT_NAME` vary — it is refusing to name physical volumes in
documentation at all and reading them out of the live containers instead.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from selfhost_release_contract import BUNDLE_SOURCE_FILES  # noqa: E402

BACKUP = ROOT / "self-host" / "backup.sh"
INSTALLER = ROOT / "self-host" / "install.sh"
COMPOSE = ROOT / "self-host" / "docker-compose.yml"
CI_SERVER = ROOT / ".github" / "workflows" / "ci-server.yml"

DOCS = (
    ROOT / "self-host" / "SELF-HOSTING.md",
    *sorted((ROOT / "docs" / "self-hosting").glob("*.md")),
    *sorted((ROOT / "apps" / "docs" / "self-hosting").glob("*.md")),
)

def code_only(source: str) -> str:
    """The helper's source with whole-line comments removed.

    The comments explain the failure mode by naming the shipped bad recipe and
    the mutable images it must not use; the assertions below are about what the
    script executes.
    """

    return "\n".join(
        line for line in source.splitlines() if not line.lstrip().startswith("#")
    )


FENCE = re.compile(r"^```(bash|sh|shell|console)\n(.*?)^```", re.MULTILINE | re.DOTALL)

# A Compose-generated physical name is "<project>_<logical>". The logical names
# are ours and fixed, so any token ending in one of them, with a prefix, is a
# guess about the operator's project — including the exact strings that shipped.
GENERATED_NAME = re.compile(
    r"\b[A-Za-z0-9][A-Za-z0-9._-]*_(server_data|pgdata|silentsuite)\b"
)


def executable_lines(path: Path) -> list[tuple[int, str]]:
    """Every line inside a shell code fence, with its 1-based file line number."""

    text = path.read_text(encoding="utf-8")
    lines: list[tuple[int, str]] = []
    for match in FENCE.finditer(text):
        first = text.count("\n", 0, match.start(2)) + 1
        for offset, line in enumerate(match.group(2).splitlines()):
            lines.append((first + offset, line))
    return lines


@pytest.mark.parametrize("doc", DOCS, ids=lambda p: str(p.relative_to(ROOT)))
def test_documentation_never_names_a_compose_generated_volume(doc):
    for number, line in executable_lines(doc):
        hit = GENERATED_NAME.search(line)
        assert hit is None, (
            f"{doc.relative_to(ROOT)}:{number} names the Compose-generated identity "
            f"{hit.group(0)!r}. Docker creates a missing named volume silently, so a "
            "guessed name can archive or destroy the wrong thing; resolve it from the "
            "live container with ./backup.sh inspect instead."
        )


@pytest.mark.parametrize("doc", DOCS, ids=lambda p: str(p.relative_to(ROOT)))
def test_documentation_does_not_script_destructive_data_loss(doc):
    forbidden = (
        "docker volume rm",
        "docker volume prune",
        "docker compose down -v",
        "docker-compose down -v",
        "docker system prune",
    )
    for number, line in executable_lines(doc):
        for command in forbidden:
            assert command not in line, (
                f"{doc.relative_to(ROOT)}:{number} scripts {command!r}; automated data-volume "
                "deletion is not supported by this release"
            )


def test_uninstall_docs_do_not_guess_a_recursive_deletion_target():
    canonical = ROOT / "docs" / "self-hosting" / "uninstalling.md"
    mirror = ROOT / "apps" / "docs" / "self-hosting" / "uninstalling.md"
    canonical_bytes = canonical.read_bytes()
    assert mirror.read_bytes() == canonical_bytes, "the uninstall docs mirrors must be byte-identical"

    text = canonical_bytes.decode("utf-8")
    assert "pwd -P" in text, "operators must inspect and record the canonical install path"
    assert "remove that exact path yourself" in text
    for number, line in executable_lines(canonical):
        assert not re.search(r"\brm\s+-[^\n]*r[^\n]*f\b", line), (
            f"{canonical.relative_to(ROOT)}:{number} scripts recursive forced deletion; "
            "an installation may use any directory name"
        )
    assert "rm -rf silentsuite-server" not in text


@pytest.mark.parametrize("doc", DOCS, ids=lambda p: str(p.relative_to(ROOT)))
def test_documentation_does_not_run_a_mutable_helper_image(doc):
    for number, line in executable_lines(doc):
        if "docker run" not in line and "docker pull" not in line:
            continue
        assert not re.search(r"\balpine\b", line), (
            f"{doc.relative_to(ROOT)}:{number} runs a mutable helper image; the backup "
            "helper reuses the admitted server container's own immutable image ID"
        )
        assert ":latest" not in line, f"{doc.relative_to(ROOT)}:{number} pins a mutable tag"


def test_the_canonical_docs_point_operators_at_the_helper():
    for doc in (
        ROOT / "self-host" / "SELF-HOSTING.md",
        ROOT / "docs" / "self-hosting" / "backup-and-restore.md",
        ROOT / "apps" / "docs" / "self-hosting" / "backup-and-restore.md",
    ):
        text = doc.read_text(encoding="utf-8")
        assert "./backup.sh inspect" in text, doc
        assert "./backup.sh backup" in text, doc


def test_the_canonical_docs_are_honest_about_recovery():
    for doc in (
        ROOT / "self-host" / "SELF-HOSTING.md",
        ROOT / "docs" / "self-hosting" / "backup-and-restore.md",
        ROOT / "apps" / "docs" / "self-hosting" / "backup-and-restore.md",
    ):
        text = doc.read_text(encoding="utf-8")
        assert "Automated restore is not supported yet" in text, doc
        assert "docker compose down" in text, f"{doc}: the supported stop path must be documented"
        assert "does **not** reverse Django migrations" in text, doc
        assert "expert assistance" in text, doc


MAINTENANCE_DOCS = tuple(
    doc for doc in DOCS
    if doc.name in {
        "backup-and-restore.md",
        "troubleshooting.md",
        "uninstalling.md",
        "updating.md",
    }
)


@pytest.mark.parametrize("doc", MAINTENANCE_DOCS, ids=lambda p: str(p.relative_to(ROOT)))
def test_maintenance_docs_do_not_rerun_the_installer_as_an_upgrade_or_reset(doc):
    for number, line in executable_lines(doc):
        if "install.sh" not in line:
            continue
        # Staging a release into a new directory is the one safe installer call:
        # it verifies and writes nothing into an existing installation.
        assert "--stage-only" in line, (
            f"{doc.relative_to(ROOT)}:{number} runs install.sh in a maintenance recipe; "
            "re-running the installer is neither an upgrade nor a reset path"
        )


@pytest.mark.parametrize("doc", DOCS, ids=lambda p: str(p.relative_to(ROOT)))
def test_no_doc_offers_a_reset_everything_recipe(doc):
    text = doc.read_text(encoding="utf-8")
    assert "reset everything" not in text.lower(), doc


# ── The helper itself ─────────────────────────────────────────────────


def test_the_helper_offers_no_destructive_command():
    source = code_only(BACKUP.read_text(encoding="utf-8"))
    for forbidden in (
        "docker volume rm",
        "docker volume prune",
        "docker system prune",
        "docker rm ",
        "docker compose down",
        "docker compose up",
        "docker pull",
        "docker image rm",
        "psql -f",
        "pg_restore",
    ):
        assert forbidden not in source, f"backup.sh must never run {forbidden!r}"
    # The only recursive removal is the helper's own partial directory.
    assert source.count("rm -rf") == 1
    assert 'rm -rf -- "$PARTIAL_DIR"' in source


def test_the_helper_resolves_identity_instead_of_guessing_it():
    source = code_only(BACKUP.read_text(encoding="utf-8"))
    hit = GENERATED_NAME.search(source)
    assert hit is None, (
        f"backup.sh builds or hard-codes the physical identity {hit.group(0) if hit else ''!r}"
    )
    # Compose resolves the project (directory, COMPOSE_PROJECT_NAME or name:),
    # which is what keeps custom projects and overrides working.
    assert "compose ps --all --quiet" in source, (
        "a stopped duplicate container is an ambiguous identity and must be seen"
    )
    assert '[ "$count" -eq 1 ]' in source
    assert '[ "$state" = "true" ]' in source
    assert "com.docker.compose.project" in source
    assert "com.docker.compose.service" in source
    assert "com.docker.compose.volume" in source


def test_the_helper_admits_only_a_plain_local_named_volume():
    source = code_only(BACKUP.read_text(encoding="utf-8"))
    for required in (
        '[ "$driver" = "local" ]',
        '[ "$scope" = "local" ]',
        '[ "$options" -eq 0 ]',
        '[ "$mtype" = "volume" ]',
        '[ "$found" -eq 1 ]',
        '[ "$SERVER_VOLUME" != "$POSTGRES_VOLUME" ]',
        '[ "$PROJECT" = "$pg_project" ]',
    ):
        assert required in source, f"backup.sh must enforce {required}"


def test_the_helper_uses_an_immutable_local_image_identity():
    source = code_only(BACKUP.read_text(encoding="utf-8"))
    assert "docker image inspect" in source
    assert "-czf - -C" in source, (
        "the archive is streamed to a host-owned file, not written through a bind mount"
    )
    assert "require_image_id" in source
    assert '[ "${#hex}" -eq 64 ]' in source and "*[!0-9a-f]*" in source, (
        "an image ID must be exactly sha256: plus 64 lowercase hex"
    )
    assert "--network none" in source
    assert "--read-only" in source
    assert "--cap-drop ALL" in source
    assert "no-new-privileges" in source
    assert "--mount" in source and "readonly,volume-nocopy" in source, (
        "the admitted volume must be mounted read-only without Docker auto-creating a missing source"
    )
    for mutable in ("alpine", ":latest", "docker pull"):
        assert mutable not in source, f"backup.sh must not depend on {mutable!r}"


def test_the_helper_proves_the_backup_is_not_empty():
    source = code_only(BACKUP.read_text(encoding="utf-8"))
    assert "django_migrations" in source
    assert '"$rows" -gt 0' in source
    assert '"$ARCHIVE_FILES" -gt 0' in source


def shell_statements(source: str) -> list[str]:
    """The helper's source grouped into logical statements.

    A statement continues while the accumulated text ends in a pipe or boolean
    continuation, or has an unclosed command substitution. That is exactly how
    the masked shape hid: the `|| true` sat on the line after the `tar` call.
    """

    statements: list[str] = []
    current = ""
    for line in source.splitlines():
        current = line if not current else f"{current}\n{line}"
        if current.rstrip().endswith(("|", "\\", "&&", "||")):
            continue
        if current.count("$(") > current.count(")"):
            continue
        statements.append(current)
        current = ""
    if current:
        statements.append(current)
    return statements


def test_no_archive_listing_can_have_its_failure_excused():
    """A tar listing whose status is discarded lets a corrupt archive pass.

    `x="$(tar -tvzf ... | grep -c '^-' || true)"` was the shipped shape: the
    `|| true` is there for grep's "no matches" exit 1, but it swallows a failing
    tar too, so a truncated archive that lists the expected members before it
    fails verifies clean once its checksums have been recomputed.
    """

    source = code_only(BACKUP.read_text(encoding="utf-8"))
    listings = [line for line in shell_statements(source) if "tar -t" in line]
    assert listings, "the helper must still list the archive to count its regular files"
    for statement in listings:
        assert "|| true" not in statement, (
            f"an archive listing excuses its own failure:\n{statement}"
        )
        assert "die " in statement, f"an archive listing does not fail closed:\n{statement}"


def test_verify_counts_regular_files_only_after_tar_exited_successfully():
    source = code_only(BACKUP.read_text(encoding="utf-8"))
    assert 'archive_listing="$(tar -tvzf "$dir/$ARCHIVE_NAME")" ||' in source, (
        "verify must capture the listing in its own statement so tar's status is checked"
    )
    assert "it is truncated or corrupt" in source
    # Counting runs over the captured listing, so `|| true` can only excuse
    # grep's zero-match status; a valid archive holding no regular file still
    # reaches the count comparison and is rejected there.
    counted = (
        'actual_archive_files="$(printf \'%s\\n\' "$archive_listing" '
        "| grep -c '^-' || true)\""
    )
    assert counted in source
    assert '[ "$actual_archive_files" = "$META_ARCHIVE_FILES" ]' in source


def test_success_output_claims_the_secret_key_only_when_it_was_archived():
    source = code_only(BACKUP.read_text(encoding="utf-8"))
    summary = source.split('echo "Backup complete: $DEST_DIR"', 1)[1].split("esac", 1)[0]
    assert 'case "$SECRET_FILE_SCOPE" in' in summary, (
        "the secret-key claim must depend on the resolved scope, not be unconditional"
    )
    preamble, arms = summary.split('case "$SECRET_FILE_SCOPE" in', 1)
    assert "secret key" not in preamble, "the unconditional secret-key claim must be gone"
    archived, external = arms.split("archived)", 1)[1].split(";;", 1)
    assert "contains your .env and your server secret key" in archived
    assert "your server secret key is NOT in this backup" in external, (
        "an external secret_file is never read or archived; saying otherwise is false"
    )
    assert "must be backed up separately" in external
    assert "$SERVER_TARGET" in external


def test_the_helper_writes_atomically_into_a_private_partial_directory():
    source = code_only(BACKUP.read_text(encoding="utf-8"))
    assert "umask 077" in source
    assert 'chmod 700 -- "$DEST_DIR" "$PARTIAL_DIR"' in source
    # -T is what makes the final step a replacement of the empty directory this
    # run claimed, rather than a move *into* whatever now sits at that name.
    assert 'mv -T -- "$PARTIAL_DIR" "$DEST_DIR"' in source
    assert "trap cleanup EXIT" in source
    assert "trap 'cleanup INT' INT" in source
    assert "trap 'cleanup TERM' TERM" in source
    assert 'die "destination' in source
    assert "assert_trusted_parent" in source
    assert '! -perm /022' in source, "a group- or world-writable parent must be refused"
    assert 'cd -P --' in source, "the parent must be canonicalised, not trusted lexically"
    assert '[ "$status" -ne 0 ] || status=1' in source, (
        "an interrupted or failed run must never exit 0"
    )


def test_publication_and_success_acknowledgement_are_signal_safe_and_ordered():
    source = code_only(BACKUP.read_text(encoding="utf-8"))
    finalise = source.split("finalise_destination() {", 1)[1].split("\n}", 1)[0]

    ignore = finalise.index("trap '' INT TERM")
    publish = finalise.index('mv -T -- "$PARTIAL_DIR" "$DEST_DIR"')
    state = finalise.index('PARTIAL_DIR=""')
    retire_exit = finalise.index("trap - EXIT")
    success = finalise.index('echo "Backup complete: $DEST_DIR"')
    restore = finalise.index("trap - INT TERM")
    assert ignore < publish < state < retire_exit < success < restore
    assert "if ! mv -T" in finalise, "EXIT cleanup must remain armed when mv fails"
    failed_mv = finalise.split("if ! mv -T", 1)[1].split("fi", 1)[0]
    assert "trap 'cleanup INT' INT" in failed_mv
    assert "trap 'cleanup TERM' TERM" in failed_mv
    assert "nothing was kept" in failed_mv


def test_the_helper_keeps_the_expected_services_and_logical_volumes():
    source = code_only(BACKUP.read_text(encoding="utf-8"))
    compose = COMPOSE.read_text(encoding="utf-8")
    for token in ("server", "postgres"):
        assert f"\n  {token}:\n" in compose, f"Compose service {token} was renamed"
    for token in ("server_data", "pgdata"):
        assert f"\n  {token}:\n" in compose, f"logical volume {token} was renamed"
    assert "SERVER_SERVICE=server" in source
    assert "POSTGRES_SERVICE=postgres" in source
    assert "SERVER_VOLUME_LABEL=server_data" in source
    assert "POSTGRES_VOLUME_LABEL=pgdata" in source
    assert "SERVER_TARGET=/data" in source
    assert "POSTGRES_TARGET=/var/lib/postgresql/data" in source


def test_the_helper_preserves_override_compatibility():
    source = code_only(BACKUP.read_text(encoding="utf-8"))
    assert "docker-compose.override.yml" in source, (
        "an operator override is part of the stack definition and belongs in the backup"
    )
    assert "compose -f" not in source and "compose(-f" not in source, (
        "pinning a single Compose file would ignore docker-compose.override.yml"
    )
    assert "--project-name" not in source and "compose -p" not in source, (
        "the helper must let Compose resolve the operator's own project identity"
    )


def test_the_helper_copies_configuration_without_following_symlinks():
    source = code_only(BACKUP.read_text(encoding="utf-8"))
    assert "iflag=nofollow" in source
    assert '[ ! -L "$PARTIAL_DIR/$name" ]' in source


def function_body(source: str, name: str) -> list[str]:
    """The executable lines of one shell function, comments already stripped."""

    assert f"{name}() {{" in source, f"{name} is missing from the helper"
    body = source.split(f"{name}() {{\n", 1)[1].split("\n}", 1)[0]
    return body.splitlines()


def test_the_configuration_copy_uses_a_bounded_no_follow_source_open():
    """The source tests are advisory; only the copy itself can fail closed.

    `[ ! -L ]` then `cp` is a time-of-check/time-of-use gap: a source replaced
    with a symlink between the two is followed by a dereferencing copy, and an
    arbitrary host file lands in the backup under a configuration file's name.
    """

    lines = function_body(code_only(BACKUP.read_text(encoding="utf-8")), "copy_config_file")

    def index_of(fragment):
        for number, line in enumerate(lines):
            if fragment in line:
                return number
        raise AssertionError(f"copy_config_file must contain {fragment!r}")

    assert not any(re.search(r'\bcp\s+', line) for line in lines), (
        "cp -P still races between classifying and opening a replaced source"
    )
    copied = index_of("dd if=")
    primitive = "\n".join(lines[copied:copied + 3])
    for flag in ("nofollow", "nonblock", "count_bytes"):
        assert flag in primitive, f"the fd-opening copy must use {flag}"
    assert 'count="$source_size"' in primitive, "a raced device read must be bounded"
    before = index_of('source_before="$(stat ')
    after = index_of('source_after="$(stat ')
    unchanged = index_of('[ "$source_before" = "$source_after" ]')

    # The copy is only accepted once the thing that landed is itself a regular
    # file, and that verdict must precede both the chmod and the inventory line
    # the metadata is built from.
    not_a_link = index_of('[ ! -L "$PARTIAL_DIR/$name" ]')
    regular = index_of('[ -f "$PARTIAL_DIR/$name" ]')
    for number in (not_a_link, regular):
        assert "die" in "\n".join(lines[number:number + 2]), (
            "a failed destination check must die so the exit trap removes the partial"
        )
    accepted = min(index_of("chmod 600"), index_of("CONFIG_FILES="))
    assert before < copied < after < unchanged < not_a_link < accepted
    assert copied < regular < accepted, (
        "the destination must be validated after the copy and before the copy is "
        "chmod'ed or recorded as a config file"
    )


def test_verify_revalidates_pinned_identities_and_content_before_success():
    lines = function_body(code_only(BACKUP.read_text(encoding="utf-8")), "cmd_verify")

    def indices(fragment):
        return [number for number, line in enumerate(lines) if fragment in line]

    checksums = indices("sha256sum --quiet --check")
    snapshots = indices('backup_identity_snapshot "$dir"')
    success = indices('echo "Backup verified:')
    assert len(checksums) == 2 and len(snapshots) == 2 and len(success) == 1
    assert snapshots[0] < checksums[0] < checksums[1] < snapshots[1] < success[0]
    assert any("manifest_digest=" in line for line in lines)
    assert any('final_snapshot" = "$verified_snapshot' in line for line in lines)


def test_the_helper_never_prints_database_credentials():
    source = code_only(BACKUP.read_text(encoding="utf-8"))
    # The credentials are expanded inside the container by its own shell, never
    # interpolated by this script and never written to metadata.
    assert '$POSTGRES_USER' in source and '${POSTGRES_USER' not in source
    metadata = source.split("cat > \"$PARTIAL_DIR/$METADATA_NAME\"", 1)[1].split("META\n", 2)[1]
    for leak in ("POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "DATABASE_PASSWORD"):
        assert leak not in metadata, f"backup metadata must not carry {leak}"


def test_the_helper_writes_a_closed_metadata_key_set_and_a_full_manifest():
    source = code_only(BACKUP.read_text(encoding="utf-8"))
    metadata = source.split("cat > \"$PARTIAL_DIR/$METADATA_NAME\"", 1)[1].split("META\n", 2)[1]
    keys = [line.split("=", 1)[0] for line in metadata.splitlines() if line.strip()]
    assert keys == [
        "schema_version",
        "created_utc",
        "compose_project",
        "server_volume",
        "postgres_volume",
        "server_image_id",
        "database_dump",
        "database_dump_bytes",
        "migration_rows",
        "server_data_archive",
        "server_data_archive_bytes",
        "server_data_files",
        "secret_file_scope",
        "config_files",
    ]
    assert len(keys) == len(set(keys)), "metadata keys must be unique"
    assert '! -name "$CHECKSUM_NAME"' in source, "the manifest covers every file but itself"
    assert "sha256sum --quiet --check" in source, "verify must re-check the manifest"
    assert "assert_checksum_grammar" in source and "assert_metadata_grammar" in source, (
        "verify must enforce the checksum and metadata grammars, not just recompute digests"
    )
    assert "does not end with a newline" in source
    assert "not in canonical filename order" in source
    assert "contains a non-regular or nested entry" in source
    assert "exact inventory declared by" in source
    assert "^[0-9a-f]{64}  [A-Za-z0-9._][A-Za-z0-9._-]*$" in source, (
        "a manifest name starting with '-' would be read as an option"
    )
    assert 'die "$METADATA_NAME is missing keys' in source
    assert "has more lines than the backup metadata grammar defines" in source
    assert '[ "$listed" = "$present" ]' in source, (
        "verify must reject added, removed or renamed files, not only edited bytes"
    )


def test_the_helper_requires_the_configured_secret_file_when_it_lives_in_the_volume():
    source = code_only(BACKUP.read_text(encoding="utf-8"))
    assert "secret_file" in source
    assert "[global]" in source, "only the effective [global] declaration counts"
    assert "$ARCHIVE_REGULAR_FILES" in source, (
        "membership must be proven against regular files, not any tar member name"
    )
    assert '"$global_sections" -eq 1' in source
    assert "does not declare secret_file" in source
    assert '"$declarations" -le 1' in source, "duplicate secret_file declarations must be rejected"
    assert "the configured secret_file is not archived as a regular file" in source
    assert "SECRET_FILE_SCOPE=external" in source, (
        "a secret_file outside /data is operator-managed and must not be read from the host"
    )


def test_backup_and_verify_read_the_config_with_one_shared_grammar():
    """Two parsers is how a false claim gets blessed.

    A verifier with its own, looser idea of what `secret_file` means can accept
    a directory the backup path would never have written. There is one parser
    for the effective `[global]` declaration and one classifier for the scope it
    resolves to, and both commands go through them.
    """

    source = code_only(BACKUP.read_text(encoding="utf-8"))
    parser = "\n".join(function_body(source, "read_secret_file_declaration"))
    classifier = "\n".join(function_body(source, "classify_secret_file"))
    elsewhere = source.replace(parser, "").replace(classifier, "")
    for grammar in (r"\[global\]", "secret_file[[:space:]]*=", '"$SERVER_TARGET"/*'):
        assert grammar not in elsewhere, (
            f"{grammar!r} is read outside the shared secret_file grammar; a second "
            "parser is a second set of rules for the same file"
        )
    for caller in ("assert_secret_file_archived", "cmd_verify"):
        body = "\n".join(function_body(source, caller))
        assert "read_secret_file_declaration " in body, f"{caller} must use the shared parser"
        assert "classify_secret_file " in body, f"{caller} must use the shared classifier"


def test_verification_refuses_a_scope_no_backup_can_produce():
    """`none` is not a scope a successful backup generates.

    Metadata and the manifest are both recomputable by whoever holds the
    directory, so a value the verifier tolerates but generation never writes is
    a free hiding place: it conceals that the server secret key is not here and
    has to be recovered from somewhere else.
    """

    source = code_only(BACKUP.read_text(encoding="utf-8"))
    grammar = "\n".join(function_body(source, "assert_metadata_grammar"))
    arm = grammar.split("      secret_file_scope)\n", 1)[1].split("\n      config_files)", 1)[0]
    assert "archived | external" in arm
    assert re.search(r"\bnone\b", arm) is None, (
        "verification must not accept secret_file_scope=none"
    )
    assert 'META_SECRET_FILE_SCOPE="$value"' in arm, (
        "the recorded scope must be captured so it can be cross-checked"
    )
    assert "SECRET_FILE_SCOPE=none" not in source, (
        "a backup run must not be able to record a placeholder scope either"
    )
    resolved = "\n".join(function_body(source, "write_metadata"))
    assert "the secret_file scope was not resolved" in resolved, (
        "generation must refuse to write an unresolved scope"
    )


def test_verify_derives_the_scope_from_the_backed_up_config_and_the_archive():
    """The recorded scope is a claim; the included config is the evidence.

    An attacker who edits `secret_file_scope` to `external` and recomputes the
    checksums makes an archived key's absence look intentional; the reverse
    edit promises a key the archive does not hold. Both are caught only by
    re-deriving the scope from the etebase-server.ini that was backed up, and
    proving the archived case against the archive that was just verified.
    """

    source = code_only(BACKUP.read_text(encoding="utf-8"))
    lines = function_body(source, "cmd_verify")
    body = "\n".join(lines)

    def index_of(fragment):
        for number, line in enumerate(lines):
            if fragment in line:
                return number
        raise AssertionError(f"cmd_verify must contain {fragment!r}")

    checked = index_of("sha256sum --quiet --check")
    read = index_of('read_secret_file_declaration "$dir/etebase-server.ini"')
    classified = index_of("classify_secret_file ")
    member = index_of("assert_archived_member ")
    compared = index_of('[ "$META_SECRET_FILE_SCOPE" = "$SECRET_FILE_SCOPE" ]')
    assert checked < read < classified < member < compared, (
        "verify must read the config only after its checksum is proven, and must "
        "prove archive membership before it accepts the recorded scope"
    )
    assert '[ "$SECRET_FILE_SCOPE" = archived ]' in body, (
        "membership is only provable for a secret_file that lives in the volume"
    )
    assert '"$archive_listing" | archive_regular_members' in body, (
        "membership must be proven against the listing tar's own exit status vouched "
        "for, and against regular members only"
    )
    assert "the archive does not hold as a regular file" in body
    assert "but etebase-server.ini resolves to" in body, (
        "a scope that disagrees with the config must be named in the refusal"
    )


def test_a_malformed_secret_file_path_is_refused_before_it_is_given_a_scope():
    """One path grammar, applied before the archived/external split.

    Classifying `/srv//key` or `/data/../etc/key` as `external` and returning
    early would hand a malformed claim a scope, and a scope is what the verifier
    cross-checks against: an unresolvable path must be refused for both scopes,
    not excused by pointing outside the volume.
    """

    source = code_only(BACKUP.read_text(encoding="utf-8"))
    lines = function_body(source, "classify_secret_file")

    def index_of(fragment):
        for number, line in enumerate(lines):
            if fragment in line:
                return number
        raise AssertionError(f"classify_secret_file must contain {fragment!r}")

    control = index_of("[[:cntrl:]]")
    absolute = index_of("is not an absolute path")
    ambiguous = index_of("*//*")
    external = index_of("SECRET_FILE_SCOPE=external")
    archived = index_of("SECRET_FILE_SCOPE=archived")
    assert control < absolute < ambiguous < external < archived, (
        "control characters, non-absolute paths and ambiguous paths must all be "
        "refused before either scope is assigned"
    )
    ambiguity_case = lines[ambiguous]
    for shape in ("*//*", "*/./*", "*../*", "*' '*"):
        assert shape in ambiguity_case, f"the shared path grammar must still refuse {shape}"
    assert "path is ambiguous" in lines[ambiguous + 1]


def test_server_volume_root_is_refused_before_the_external_scope():
    """The volume root is neither an archived file nor an external key.

    Backup generation and verification share this classifier, so both must stop
    on the exact target before the external return can misdescribe it.
    """

    source = code_only(BACKUP.read_text(encoding="utf-8"))
    lines = function_body(source, "classify_secret_file")
    body = "\n".join(lines)
    exact = next(i for i, line in enumerate(lines) if '"$SERVER_TARGET")' in line)
    external = next(i for i, line in enumerate(lines) if "SECRET_FILE_SCOPE=external" in line)
    archived = next(i for i, line in enumerate(lines) if "SECRET_FILE_SCOPE=archived" in line)
    assert exact < external < archived
    assert "names $SERVER_TARGET itself, not a file in it" in lines[exact + 1]
    assert '${value#"$SERVER_TARGET"/}' in body, "archived paths must remain relative to the volume"
    for caller in ("assert_secret_file_archived", "cmd_verify"):
        assert "classify_secret_file " in "\n".join(function_body(source, caller)), (
            f"{caller} must inherit the exact-root rejection"
        )


def test_an_external_secret_file_is_classified_and_never_read():
    """A path outside /data is operator-managed, in backup and in verify alike.

    Opening it would say nothing about the backup directory — the file may exist
    on this host and still be absent from the backup, or the reverse — and would
    pull an operator's key into a code path that has no business holding it.
    """

    source = code_only(BACKUP.read_text(encoding="utf-8"))
    classifier = "\n".join(function_body(source, "classify_secret_file"))
    assert "SECRET_FILE_SCOPE=external" in classifier
    for probe in ('"$value"]', '-f "$value"', '-e "$value"', 'cat "$value"', 'cat -- "$value"'):
        assert probe not in classifier, f"the declared path must not be opened ({probe})"
    for line in (line.strip() for line in source.splitlines()):
        if "SECRET_FILE_VALUE" not in line:
            continue
        assert line.startswith(("SECRET_FILE_VALUE=", "classify_secret_file ")), (
            f"the declared secret_file path is only ever classified, never used: {line}"
        )


def test_verify_is_read_only_and_does_not_require_docker():
    source = code_only(BACKUP.read_text(encoding="utf-8"))
    entrypoint = source.split('action="$1"', 1)[1]
    verify_arm = entrypoint.split("verify)", 1)[1].split(";;", 1)[0]
    assert "docker" not in verify_arm


# ── Release wiring ────────────────────────────────────────────────────


def test_the_helper_ships_in_the_release_bundle():
    assert "backup.sh" in BUNDLE_SOURCE_FILES
    assert BUNDLE_SOURCE_FILES == tuple(sorted(BUNDLE_SOURCE_FILES, key=str))


def test_the_installer_admits_installs_and_marks_the_helper_executable():
    source = INSTALLER.read_text(encoding="utf-8")
    expected = source.split("EXPECTED_MEMBERS=", 1)[1].split("LC_ALL=C sort)", 1)[0]
    assert "backup.sh" in expected, "the closed bundle inventory must include backup.sh"
    copy_loop = source.split("for file in docker-compose.yml", 1)[1].split("\n", 1)[0]
    assert "backup.sh" in copy_loop, "the installer must copy backup.sh into the install directory"
    chmod_line = next(line for line in source.splitlines() if line.startswith("chmod +x "))
    assert "backup.sh" in chmod_line, "backup.sh must be installed executable"


def test_the_helper_is_a_tracked_executable_shell_script():
    assert BACKUP.exists()
    assert BACKUP.read_text(encoding="utf-8").startswith("#!/usr/bin/env bash")
    assert BACKUP.stat().st_mode & 0o111, "backup.sh must be executable in the repository"


def test_ci_covers_the_helper():
    workflow = CI_SERVER.read_text(encoding="utf-8")
    assert workflow.count("- 'self-host/**'") == 2, (
        "push and pull_request path filters must both cover self-host/, including backup.sh"
    )
    syntax_loop = workflow.split("Check release and self-host shell syntax", 1)[1].split(
        "bash -n", 1
    )[0]
    assert "self-host/backup.sh" in syntax_loop, "backup.sh must be syntax-checked in CI"


# ── The behavioural fixture ───────────────────────────────────────────

HARNESS = ROOT / "tests" / "fixtures" / "self-host-backup" / "harness.sh"


def ci_job(name: str) -> str:
    workflow = CI_SERVER.read_text(encoding="utf-8")
    body = workflow.split(f"\n  {name}:\n", 1)[1]
    return body.split("\n  ", 1)[0] if re.match(r"^[a-z]", body) else re.split(r"\n  [a-z-]+:\n", body)[0]


def test_the_behavioural_fixture_is_wired_into_ci():
    workflow = CI_SERVER.read_text(encoding="utf-8")
    assert workflow.count("- 'tests/fixtures/self-host-backup/**'") == 2, (
        "push and pull_request path filters must both cover the behavioural fixture"
    )
    syntax_loop = workflow.split("Check release and self-host shell syntax", 1)[1].split(
        "bash -n", 1
    )[0]
    assert "tests/fixtures/self-host-backup/harness.sh" in syntax_loop
    assert "self-host-backup-behaviour:" in workflow
    assert "tests/fixtures/self-host-backup/harness.sh" in workflow.split(
        "self-host-backup-behaviour:", 1
    )[1]


def test_the_behavioural_job_is_github_hosted_and_credential_free():
    job = ci_job("self-host-backup-behaviour")
    assert "runs-on: ubuntu-latest" in job, "the fixture must run on a GitHub-hosted AMD64 runner"
    assert "self-hosted" not in job
    assert "permissions:\n      contents: read" in job
    for forbidden in ("secrets.", "environment:", "packages:", "docker/login-action", "push: true"):
        assert forbidden not in job, f"the behavioural job must not use {forbidden!r}"
    assert "persist-credentials: false" in job


def test_the_native_image_jobs_are_unchanged_by_the_fixture():
    workflow = CI_SERVER.read_text(encoding="utf-8")
    image_job = workflow.split("\n  self-host-image:\n", 1)[1]
    assert "ubuntu-24.04-arm" in image_job
    assert "runner: ubuntu-24.04\n" in image_job
    assert "push: false" in image_job


def test_the_fixture_covers_both_project_names_and_the_negative_identities():
    harness = HARNESS.read_text(encoding="utf-8")
    assert "default project name" in harness and "custom project name" in harness
    assert "COMPOSE_PROJECT_NAME" in harness
    assert "django_migrations" in harness, "the database sentinel must be real migration rows"
    assert "sentinel_rows" in harness
    assert "media-sentinel.bin" in harness, "the server volume must be non-empty"
    assert "docker-compose.override.yml" in harness, "the custom-project run must exercise override compatibility"
    for variant in ("bind", "shared", "redirected", "options"):
        assert f'"{variant}"' in harness or f" {variant})" in harness, variant
    assert "left a backup directory behind" in harness, (
        "a refused identity must fail before any backup directory exists"
    )
    assert "verify accepted database corruption with an unchanged manifest" in harness
    assert "same-length edit with a recomputed valid unauthenticated manifest" in harness
    assert "verify accepted metadata with an unexpected key" in harness
    assert "SABOTAGE_MODE" in harness
    assert "between validation phases" in harness


def test_the_fixture_uses_the_old_guessed_names_only_as_untouched_decoys():
    harness = HARNESS.read_text(encoding="utf-8")
    assert 'DECOYS=("self-host_server_data" "self-host_pgdata")' in harness, (
        "the fixture must plant exactly the names the shipped documentation guessed"
    )
    assert "assert_decoys_untouched" in harness
    assert "the helper resolved to the guessed decoy volume" in harness


def test_the_fixture_cleans_up_only_after_itself():
    harness = HARNESS.read_text(encoding="utf-8")
    assert "trap cleanup EXIT" in harness
    assert 'SUFFIX="$$-$(date +%s)"' in harness, "fixture identities must be run-scoped"
    assert "refusing to run: a volume named" in harness, (
        "the fixture must refuse to run if a decoy name already exists on the host"
    )
    assert "mktemp -d" in harness
    # The only image it runs is the digest this repository already pins.
    assert harness.count("IMAGE=") == 1
    assert "postgres@sha256:" in harness
    assert ":latest" not in harness


@pytest.mark.parametrize("name", ["backup-and-restore.md", "uninstalling.md"])
def test_the_two_documentation_trees_stay_aligned(name):
    """These two pages are sibling copies; a fix applied to one is a fix to both."""

    published = (ROOT / "docs" / "self-hosting" / name).read_text(encoding="utf-8")
    site = (ROOT / "apps" / "docs" / "self-hosting" / name).read_text(encoding="utf-8")
    assert published == site, f"docs/self-hosting/{name} and its apps/docs sibling have drifted"
