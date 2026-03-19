from setuptools import find_packages, setup

setup(
    name="silentsuite-server",
    version="0.15.0",
    description="End-to-end encrypted sync server for calendar, contacts & tasks. Built on the Etebase protocol.",
    url="https://github.com/silent-suite/silentsuite-server",
    author="Silent Suite",
    author_email="info@silentsuite.io",
    classifiers=[
        "Development Status :: 4 - Beta",
        "Framework :: Django",
        "Framework :: FastAPI",
        "Intended Audience :: System Administrators",
        "License :: OSI Approved :: GNU Affero General Public License v3",
    ],
    packages=find_packages(include=["etebase_server", "etebase_server.*"]),
    install_requires=list(open("requirements.in/base.txt")),
    package_data={
        "etebase_server": ["templates/*"],
    },
)
