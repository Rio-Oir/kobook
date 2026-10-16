// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from 'node:assert/strict';
import {test,beforeEach} from 'node:test';
import {installLocalStorage} from './byok-fake-provider.js';
installLocalStorage();
const {useStore}=await import('../../src/lib/store.js');
const {createLocalBackup,restoreLocalBackup,validateLocalBackup}=await import('../../src/lib/local-backup.js');
beforeEach(()=>{useStore.getState().clearUserCache();localStorage.clear();});
function seed(){useStore.getState().saveArticle({id:'local-a',title:'备份',createdAt:1,paragraphs:[{index:1,text:'正文内容',hash:'h'}]});}
test('backup roundtrip keeps text/annotations and excludes credentials and cloud identity',()=>{
 seed(); const s=useStore.getState();
 s.addHighlight({articleId:'local-a',paragraphIndex:1,startOffset:0,endOffset:2,selectionText:'正文',color:'green'});
 localStorage.setItem('gloss-settings','synthetic-secret');
 const raw=createLocalBackup();assert.ok(!raw.includes('synthetic-secret'));assert.ok(!raw.includes('ownerUserId'));
 useStore.getState().clearUserCache();restoreLocalBackup(raw);assert.equal(createLocalBackup(),raw);
 restoreLocalBackup(raw);assert.equal(Object.keys(useStore.getState().articles).length,1);
});
test('restore rejects conflicts, unknown credential fields, future versions and bad anchors without mutation',()=>{
 seed();const raw=createLocalBackup();const before=localStorage.getItem('gloss-storage');
 for(const mutate of [(v:any)=>v.apiKey='secret',(v:any)=>v.version=2,(v:any)=>v.articles['local-a'].title='conflict',
 (v:any)=>v.highlights.x={id:'x',articleId:'local-a',paragraphIndex:1,startOffset:0,endOffset:2,selectionText:'错文',color:'green',createdAt:1}]){
 const value=JSON.parse(raw);mutate(value);assert.throws(()=>restoreLocalBackup(JSON.stringify(value)));
 assert.equal(localStorage.getItem('gloss-storage'),before);assert.equal(createLocalBackup(),raw);
 }
});
test('storage refusal leaves memory and existing disk untouched',()=>{
 seed();const raw=createLocalBackup();useStore.getState().clearUserCache();const before=localStorage.getItem('gloss-storage');
 const original=localStorage.setItem;localStorage.setItem=()=>{throw new Error('QuotaExceeded');};
 try{assert.throws(()=>restoreLocalBackup(raw));assert.equal(Object.keys(useStore.getState().articles).length,0);assert.equal(localStorage.getItem('gloss-storage'),before);}
 finally{localStorage.setItem=original;}
 assert.equal(validateLocalBackup(raw).version,1);
});
test('backup preserves cancelled turns and partial answer; running snapshots restore as interrupted',()=>{
 seed();useStore.setState({notes:{n:{id:'n',articleId:'local-a',paragraphIndex:1,type:'ask',selectionText:'正文',question:'为何',answer:'部分回答',model:'synthetic',isStreaming:true,createdAt:2,
 startParagraphIndex:1,startOffset:0,endParagraphIndex:1,endOffset:2,
 turns:[{id:'turn-1',noteId:'n',sequence:1,role:'assistant',content:'先前部分回答',createdAt:'2026-10-15T00:00:00Z',status:'cancelled'}]}}});
 const raw=createLocalBackup();const data=validateLocalBackup(raw);assert.equal(data.notes.n?.localStatus,'interrupted');assert.equal(data.notes.n?.turns?.[0]?.status,'cancelled');
 useStore.getState().clearUserCache();restoreLocalBackup(raw);assert.equal(useStore.getState().notes.n?.answer,'部分回答');assert.equal(useStore.getState().notes.n?.isStreaming,false);
 const invalid=JSON.parse(raw);invalid.notes.n.selectionText='错误';assert.throws(()=>validateLocalBackup(JSON.stringify(invalid)));
});
