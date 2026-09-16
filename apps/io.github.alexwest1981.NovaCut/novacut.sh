#!/bin/sh
# NovaCut entry point.
#
# zypak-wrapper comes from org.electronjs.Electron2.BaseApp and is what makes
# Chromium's sandbox work inside a flatpak; without it Electron exits with the
# "SUID sandbox helper binary was found, but is not configured correctly"
# error. The app directory is handed to Electron, which reads package.json's
# main (src/main.js) from it.
#
# The switches are the project's own bin/novacut launcher verbatim: the app is
# built for Wayland, and hardware-accelerated decode is what makes preview
# playback cheap on the machines it targets.
exec zypak-wrapper /app/novacut/node_modules/electron/dist/electron /app/novacut \
  --name=NovaCut \
  --class=NovaCut \
  --ozone-platform=wayland \
  --disable-vulkan \
  --enable-features=VaapiVideoDecodeLinuxGL,VaapiVideoDecoder \
  "$@"
