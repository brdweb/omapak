#!/bin/sh
# OmaScribe entry point.
#
# The application is run from its installed source tree, the same way the
# project's own install.sh runs it (`python3 main.py`): main.py resolves its
# own directory and core/, ui/ and locales/ are found relative to it.
# python3 is the interpreter from org.kde.Platform (3.13), on which the PyQt
# BaseApp's PyQt6 is built; both are on the search path here.
exec python3 /app/omascribe/main.py "$@"
