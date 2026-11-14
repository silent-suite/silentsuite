"""Sign up one synthetic Etebase account on the CI-local test server and seed its contacts.

Usage: python signup.py <server_url> <username> <password>          sign up, seed contacts 1-3
       python signup.py <server_url> <username> <password> add <n>  add contact <n>
Only for the throwaway server started by android-upgrade-sync-check.yml.

Seeds one address book (etebase.vcard) with vCard 4.0 contacts whose phone numbers have no
type, a standard type, or a custom label, so each phase's contacts sync has to download and
parse vCards whatever the device does.
"""

import sys
import time

from etebase import Account, Client, User


def millis() -> int:
    return int(time.time() * 1000)


def phone(n: int) -> str:
    number = f"+1555010000{n}"
    kind = n % 3
    if kind == 1:
        return f"TEL:{number}\r\n"  # no type
    if kind == 2:
        return f"item1.TEL:{number}\r\nitem1.X-ABLabel:Boat\r\n"  # custom label
    return f"TEL;TYPE=cell:{number}\r\n"


def vcard(n: int) -> str:
    uid = f"repro-contact-{n}"
    return (
        "BEGIN:VCARD\r\n"
        "VERSION:4.0\r\n"
        f"UID:{uid}\r\n"
        f"FN:Repro Server{n}\r\n"
        f"N:Server{n};Repro;;;\r\n"
        f"{phone(n)}"
        f"EMAIL:server{n}@example.invalid\r\n"
        "END:VCARD\r\n"
    )


def add(client: Client, username: str, password: str, n: int) -> None:
    account = Account.login(client, username, password)
    col_mgr = account.get_collection_manager()
    cols = [c for c in col_mgr.list("etebase.vcard", None).data if not c.deleted]
    if len(cols) != 1:
        sys.exit(f"expected exactly one address book, found {len(cols)}")
    item_mgr = col_mgr.get_item_manager(cols[0])
    item_mgr.batch([item_mgr.create({"name": f"repro-contact-{n}", "mtime": millis()}, vcard(n).encode())], None, None)
    account.logout()
    print(f"added contact {n}")


def main() -> None:
    server_url, username, password = sys.argv[1:4]
    client = Client("silentsuite-ci-upgrade-check", server_url)
    if len(sys.argv) > 4:
        if sys.argv[4] != "add":
            sys.exit("usage: signup.py <url> <user> <pass> [add <n>]")
        add(client, username, password, int(sys.argv[5]))
        return
    account = Account.signup(client, User(username, f"{username}@example.invalid"), password)
    col_mgr = account.get_collection_manager()
    col = col_mgr.create("etebase.vcard", {"name": "Repro contacts", "mtime": millis()}, b"")
    col_mgr.upload(col, None)
    item_mgr = col_mgr.get_item_manager(col)
    items = [
        item_mgr.create({"name": f"repro-contact-{n}", "mtime": millis()}, vcard(n).encode())
        for n in (1, 2, 3)
    ]
    item_mgr.batch(items, None, None)
    account.logout()
    print(f"signed up synthetic account {username} with 1 address book and {len(items)} contacts")


if __name__ == "__main__":
    main()
