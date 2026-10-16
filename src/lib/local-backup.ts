// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from 'zod';
import { useStore } from './store';

const text = z.string().max(2_000_000);
const id = z.string().min(1).max(500).refine(v => v!=='prototype' && !Object.hasOwn(Object.prototype,v));
const num = z.number().finite().nonnegative();
const offset = num.int();
const status = z.enum(['running','succeeded','failed','cancelled','interrupted']);
const span = z.object({start:offset,end:offset,kinds:z.array(z.enum(['strong','em','code','del','link'])),href:text.optional()}).strict();
const paragraph = z.object({index:offset,text,hash:text,blockId:text.optional(),type:z.enum(['heading','paragraph','listItem','code','quote']).optional(),level:z.number().int().min(1).max(6).optional(),lang:text.nullable().optional(),ordered:z.boolean().optional(),spans:z.array(span).optional()}).strict();
const article = z.object({id,title:text,url:text.optional(),author:text.optional(),publishedAt:text.optional(),paragraphs:z.array(paragraph).min(1),createdAt:num,
  brief:z.object({gist:text,claims:z.array(z.object({text,paragraphRef:text}).strict()),generatedAt:num}).strict().optional()}).strict();
const turn = z.object({id,noteId:id,sequence:offset,role:z.enum(['user','assistant']),content:text,createdAt:text,clientTurnId:text.optional(),status:z.enum(['succeeded','failed','cancelled','interrupted']).optional()}).strict();
const note = z.object({id,articleId:id,paragraphIndex:offset,type:z.enum(['explain','ask']),selectionText:text,question:text,answer:text,model:text,isStreaming:z.literal(false),createdAt:num,
  startParagraphIndex:offset.optional(),startOffset:offset.optional(),endParagraphIndex:offset.optional(),endOffset:offset.optional(),startBlockId:text.optional(),endBlockId:text.optional(),localStatus:status.optional(),turns:z.array(turn).optional()}).strict();
const highlight = z.object({id,articleId:id,paragraphIndex:offset,startOffset:offset,endOffset:offset,selectionText:text,color:z.enum(['yellow','green','blue','red']),style:z.enum(['watercolor','line','curve']).optional(),createdAt:num}).strict();
const schema = z.object({format:z.literal('gloss-local-backup'),version:z.literal(1),articles:z.record(article),notes:z.record(note),highlights:z.record(highlight)}).strict();
type Backup = z.infer<typeof schema>;
function pick(value: object, fields: string[]) {
  return Object.fromEntries(fields.filter(k => Object.hasOwn(value,k)).map(k => [k,(value as Record<string,unknown>)[k]]));
}
const articleFields = Object.keys(article.shape);
const noteFields = Object.keys(note.shape);
export function createLocalBackup(): string {
  const state=useStore.getState();
  const data = {format:'gloss-local-backup',version:1,
    articles:Object.fromEntries(Object.entries(state.articles).map(([k,v])=>[k,pick(v,articleFields)])),
    notes:Object.fromEntries(Object.entries(state.notes).map(([k,v])=>[k,{...pick(v,noteFields),isStreaming:false,
      ...(v.isStreaming?{localStatus:'interrupted'}:{}),
      ...(v.turns?{turns:v.turns.map(t=>pick(t,Object.keys(turn.shape)))}:{})}])),
    highlights:Object.fromEntries(Object.entries(state.highlights).map(([k,v])=>[k,pick(v,Object.keys(highlight.shape))]))};
  // Validation is shared with restore; credentials/settings/queues never enter.
  return JSON.stringify(validateLocalBackup(JSON.stringify(data)),null,2);
}
export function validateLocalBackup(raw: string): Backup {
  if(new TextEncoder().encode(raw).length>20*1024*1024) throw new Error('备份超过20 MB上限。');
  const data=schema.parse(JSON.parse(raw));
  for(const [key,a] of Object.entries(data.articles)) {
    if(key!==a.id) throw new Error('文章标识不一致。');
    for(let i=0;i<a.paragraphs.length;i++) {
      const p=a.paragraphs[i]!;
      if(p.index!==i+1) throw new Error('段落顺序不正确。');
      for(const s of p.spans??[]) if(s.start>=s.end||s.end>p.text.length) throw new Error('正文格式范围无效。');
    }
  }
  for(const group of [data.notes,data.highlights]) for(const [key,n] of Object.entries(group)) {
    const a=data.articles[n.articleId];
    if(key!==n.id||!a||!a.paragraphs.some(p=>p.index===n.paragraphIndex)) throw new Error('笔记或划线所属文章无效。');
    if('color' in n) {
      const p=a.paragraphs.find(p=>p.index===n.paragraphIndex)!;
      if(n.startOffset>=n.endOffset||p.text.slice(n.startOffset,n.endOffset)!==n.selectionText) throw new Error('划线范围与正文不一致。');
    } else if(n.startParagraphIndex !== undefined || n.endParagraphIndex !== undefined || n.startOffset !== undefined || n.endOffset !== undefined) {
      const first=a.paragraphs.find(p=>p.index===n.startParagraphIndex),last=a.paragraphs.find(p=>p.index===n.endParagraphIndex);
      if(!first||!last||n.startOffset===undefined||n.endOffset===undefined||first.index>last.index||n.startOffset>first.text.length||n.endOffset>last.text.length) throw new Error('笔记范围无效。');
      const selected=a.paragraphs.filter(p=>p.index>=first.index&&p.index<=last.index).map(p=>p.text.slice(p===first?n.startOffset:0,p===last?n.endOffset:undefined)).join('\n');
      const normalized=(v:string)=>v.replace(/\s+/g,' ').trim();
      if(normalized(selected)!==normalized(n.selectionText)) throw new Error('笔记范围与引文不一致。');
    }
  }
  return data;
}
export function restoreLocalBackup(raw: string): void {
  const backup=validateLocalBackup(raw), state=useStore.getState();
  // Additive restore refuses every differing collision before writing.
  const current=JSON.parse(createLocalBackup()) as Backup;
  for(const group of ['articles','notes','highlights'] as const) for(const [key,value] of Object.entries(backup[group])) {
    if(current[group][key] && JSON.stringify(current[group][key])!==JSON.stringify(value)) throw new Error('备份与当前记录冲突，未恢复；请保留两份备份。');
  }
  const next={...state,articles:{...backup.articles,...state.articles},notes:{...backup.notes,...state.notes},highlights:{...backup.highlights,...state.highlights}};
  // Prove disk accepts the complete candidate before publishing memory.
  // This synchronous operation cannot race another event in this tab.
  localStorage.setItem('gloss-storage',JSON.stringify({state:next,version:2}));
  useStore.setState(next);
}
export function downloadLocalBackup(): void {
  const url=URL.createObjectURL(new Blob([createLocalBackup()],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=`gloss-backup-${Date.now()}.json`;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
