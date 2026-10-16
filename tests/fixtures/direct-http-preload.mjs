// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Isolated test-process transport fixture. Production never imports this file.
import https from 'node:https';
import dns from 'node:dns/promises';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
if (process.env.NODE_ENV !== 'test') throw new Error('test fixture only');
const lookup = dns.lookup;
dns.lookup = async (host, options) => host === 'example.com'
  ? (options?.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 })
  : lookup(host, options);
const original = https.request;
https.request = function(options, callback) {
  if (options.servername !== 'example.com') return original.call(this, options, callback);
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy = err => { if (err) queueMicrotask(() => req.emit('error', err)); return req; };
  req.end = () => queueMicrotask(() => {
    const res = new PassThrough();
    if (options.path === '/redirect-test') {
      res.statusCode = 302; res.headers = { location: 'http://10.0.0.1/post' }; req.emit('response', res); res.end(); return;
    }
    res.statusCode = 200; res.statusMessage = 'OK'; res.headers = { 'content-type': 'text/html' };
    if (callback) callback(res);
    req.emit('response', res);
    res.end('<html><head><title>URL 导入测试标题</title></head><body><article><h1>URL 导入测试标题</h1><p>深度学习模型的训练需要大量计算资源，许多团队因此选择使用云端 GPU 集群。</p><ul><li>列表项</li></ul></article></body></html>');
  });
  return req;
};
syncBuiltinESMExports();
