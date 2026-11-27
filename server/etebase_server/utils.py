# Copyright © 2017 Tom Hacohen
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, version 3.
#
# This library is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <http://www.gnu.org/licenses/>.

import os
import stat

from django.core.exceptions import ImproperlyConfigured
from django.core.management import utils


def get_secret_from_file(path):
    try:
        with open(path, "r") as f:
            return f.read().strip()
    except EnvironmentError:
        with open(path, "w") as f:
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
            secret_key = utils.get_random_secret_key()
            f.write(secret_key)
            return secret_key


def signup_mode(registration_token: str, owner_password: str, hosted_pass_required: bool) -> str:
    """The name of the configured signup mode (never any configured value).

    The hosted signup pass replaces the self-host registration token and owner modes, which use the
    same request header, so combining them is a configuration error.
    """
    if hosted_pass_required:
        if registration_token or owner_password:
            raise ImproperlyConfigured(
                "ETEBASE_HOSTED_SIGNUP_PASS_REQUIRED cannot be combined with "
                "ETEBASE_REGISTRATION_TOKEN or ETEBASE_OWNER_PASSWORD"
            )
        return "hosted-pass"
    if owner_password:
        return "owner"
    if registration_token:
        return "registration-token"
    return "open"
