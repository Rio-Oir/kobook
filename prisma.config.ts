// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Prisma 7 configuration.
//
// Prisma 7 moved the datasource URL out of `schema.prisma` and into this
// config file, so the connection string is supplied by the environment at
// CLI time rather than being committed with the schema.
//
// The URL is read from DATABASE_URL. For the local development and test
// databases see the npm scripts; both are loopback-only, and the test
// script additionally requires the database name to contain `_test`.

import "dotenv/config";
import { defineConfig } from "prisma/config";

const databaseUrl = process.env["DATABASE_URL"];

export default defineConfig({
  schema: "server/prisma/schema.prisma",
  migrations: {
    path: "server/prisma/migrations",
  },
  datasource: {
    ...(databaseUrl ? { url: databaseUrl } : {}),
  },
});
