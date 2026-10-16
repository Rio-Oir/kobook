// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {evidenceDir} from '../../scripts/evidence-dir.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
// Logs land under `artifacts/`, which the repository ignores, unless
// `EVIDENCE_DIR` points the run somewhere else (see `scripts/evidence-dir.mjs`).
// The value is inherited by every step below, so one setting covers the
// production build, the service inject tests and the browser run.
const evidence=evidenceDir('base-acceptance');
const tests=JSON.parse(readFileSync(path.join(root,'apps/reader-release/base-tests.json'),'utf8'));
// Steps are `[name, args, envOverrides?]`.
//
// `NODE_ENV` defaults to `test` for the whole run: the inject fixture refuses
// to serve under any other value, and the browser service reads it too. The
// production build is the one exception, and it has to be: Vite maps
// `NODE_ENV` straight onto its build mode, so building with `test` bundles
// React's *development* build — 27% larger, with dev-only warnings and none of
// the production error handling. The step was named "production-build" while
// doing that. Pinning `production` here is what makes the name true, and it
// means the browser step below exercises the artifact we would actually
// release.
const steps=[
 ['frontend-types',['node_modules/typescript/bin/tsc','--noEmit']],
 ['base-test-types',['node_modules/typescript/bin/tsc','-p','apps/reader-release/tsconfig.base-tests.json','--noEmit']],
 ['base-units',['--import','tsx','--test',...tests]],
 ['production-build',['apps/reader-release/build.mjs'],{NODE_ENV:'production'}],
 ['anonymous-service',['--import','tsx','--import','./tests/fixtures/direct-http-preload.mjs','apps/reader-release/tests/server-inject.mjs']],
 ['real-browser',['--import','tsx','apps/reader-release/tests/base-browser.mjs']],
];
// Git for Windows bundles OpenSSL; resolve it without a machine-specific path.
const env={...process.env,NODE_ENV:'test'};
if(process.platform==='win32'&&!env.OPENSSL_BIN){
 const gitPaths=spawnSync('where.exe',['git'],{encoding:'utf8'}).stdout?.trim().split(/\r?\n/)??[];
 for(const executable of gitPaths){
  const candidate=path.resolve(path.dirname(executable),'../usr/bin/openssl.exe');
  if(existsSync(candidate)){env.OPENSSL_BIN=candidate;break;}
 }
}
const results=[];
for(const [name,args,overrides] of steps){
 const started=Date.now();
 const result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024,env:{...env,...(overrides??{})}});
 const output=(result.stdout??'')+(result.stderr??'');
 writeFileSync(path.join(evidence,name+'.log'),output);
 results.push({name,command:['node',...args],exitCode:result.status,error:result.error?.message,seconds:(Date.now()-started)/1000,...(overrides?{env:overrides}:{})});
 console.log(name+': '+result.status+'\n'+output.slice(-500));
 if(result.status!==0)break;
}
const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim();
const lockHash=createHash('sha256').update(readFileSync(path.join(root,'package-lock.json'))).digest('hex');
writeFileSync(path.join(evidence,'result.json'),JSON.stringify({at:new Date().toISOString(),checkpoint:git,node:process.version,lockHash,pass:results.length===steps.length&&results.every(r=>r.exitCode===0),scope:'base only; no cloud/database/auth/payment integration',selectedTests:tests,results},null,2)+'\n');
if(results.length!==steps.length||results.some(r=>r.exitCode!==0))process.exitCode=1;
