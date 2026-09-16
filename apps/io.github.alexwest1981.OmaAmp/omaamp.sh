#!/bin/sh
# OmaAmp entry point.
#
# Run from the installed source tree, the same way the project's own install.sh
# runs it (`python3 main.py`): main.py resolves its own directory and core/,
# ui/, skins/ and themes/ are found relative to it (the skins and themes ship
# in the repository, so they are installed alongside the code).
# python3 is the interpreter from org.kde.Platform (3.13), on which the PyQt
# BaseApp's PyQt6 is built; both are on the search path here.
exec python3 /app/omaamp/main.py "$@"
