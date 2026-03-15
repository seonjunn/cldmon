#!/bin/sh
# Generates a random 32-byte hex string suitable for use as sessionSecret in config.json
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
