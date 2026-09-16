#!/bin/sh
# OmarchyTube entry point.
#
# zypak-wrapper comes from org.electronjs.Electron2.BaseApp and is what makes
# Chromium's sandbox work inside a flatpak; without it Electron exits with the
# "SUID sandbox helper binary was found, but is not configured correctly"
# error. Electron is handed the app directory, which is the tree npm installed
# into during the build.
exec zypak-wrapper /app/omarchy-tube/node_modules/electron/dist/electron /app/omarchy-tube "$@"
