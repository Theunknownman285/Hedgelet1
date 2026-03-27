#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
pnpm --filter @workspace/scripts run notify-discord "The Hedgelet app has been updated and deployed! 🦔"
