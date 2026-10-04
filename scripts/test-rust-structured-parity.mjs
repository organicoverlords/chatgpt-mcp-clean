import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
process.env.MCP_LOCAL_ENGINE_URL=process.env.CONTRACT_ENGINE_URL??'http://127.0.0.1:3575/mcp';
const {createServer}=await import('../dist/server.js');
const server=createServer('structured-parity-fixture');
const client=new Client({name:'structured-parity-fixture',version:'1'});
const [a,b]=InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a),client.connect(b)]);
async function run(args){
 let r=await client.callTool({name:'start_process',arguments:{...args,wait_ms:1000}});
 assert.notEqual(r.isError,true,JSON.stringify(r));let v=r.structuredContent,out=v.stdout,err=v.stderr;
 const end=Date.now()+15000;
 while(v.next_action!=='STOP_READING'){
  assert.ok(Date.now()<end,'finite fixture deadline');
  r=await client.callTool({name:'read_output',arguments:{process_id:v.process_id,wait_ms:1000,max_chars:10000}});
  assert.notEqual(r.isError,true,JSON.stringify(r));v=r.structuredContent;out+=v.stdout;err+=v.stderr;
 }
 assert.equal(v.exit_code,0,JSON.stringify({v,err}));return out;
}
try{
 const argv=['A B','quote"single\'','dollar$HOME','backtick`','line1\nline2','&&','|','unicode😀ä','','C:\\with space\\tail\\'];
 assert.deepEqual(JSON.parse(await run({executable:process.execPath,args:['-e','process.stdout.write(JSON.stringify(process.argv.slice(1)))',...argv]})),argv);
 const stdin='UTF8😀ä\nA\u0000B\r\n';
 assert.equal(await run({executable:process.execPath,args:['-e','process.stdin.pipe(process.stdout)'],stdin}),stdin);
 assert.equal(await run({language:'node',script:'process.stdout.write(process.env.MCP_PARITY_ENV)',env:{MCP_PARITY_ENV:'child-only'}}),'child-only');
 assert.equal(process.env.MCP_PARITY_ENV,undefined);
 assert.equal(await run({language:'python',script:'import os,sys\nsys.stdout.write(os.environ["MCP_PARITY_ENV"])\n',env:{MCP_PARITY_ENV:'python-child'}}),'python-child');
 if(process.platform==='win32'){
  assert.equal(await run({language:'powershell',script:'& cmd.exe /d /s /c "exit 7" || [Console]::Out.Write("PS7😀ä")'}),'PS7😀ä');
  assert.equal(await run({language:'powershell',script:"$literal='A\u0000B'; [Console]::Out.Write($literal.Length)"}),'3');
  assert.equal((await run({executable:'pwsh',args:['-NoProfile','-Command','[Console]::Out.Write($PSVersionTable.PSVersion.Major)']})).trim(),'7');
  assert.match(await run({executable:'cmd.exe',args:['/d','/s','/c','echo CMD_A & echo CMD_B']}),/CMD_A[\s\S]*CMD_B/);
  const root=mkdtempSync(join(tmpdir(),'mcp-argv-parity-'));
  try {
   const shim=join(root,'echo-arg.cmd');writeFileSync(shim,'@echo off\r\necho ARG=%~1\r\n');
   assert.match(await run({executable:shim,args:['A B']}),/ARG=A B/);
   const rejected=await client.callTool({name:'start_process',arguments:{executable:shim,args:['line1\nline2'],wait_ms:1000}});
   assert.equal(rejected.isError,true);
  }finally { assert.ok(resolve(root).startsWith(resolve(tmpdir())+'\\'));rmSync(root,{recursive:true,force:true}); }
  console.log('PASS Windows PowerShell7 scripts, chain, NUL source, pwsh resolution, cmd composition');
 }else{
  assert.equal(await run({language:'bash',script:'printf "BASH_OK"\n'}),'BASH_OK');
 }
 console.log('PASS native opaque argv, empty/multiline args, exact Unicode/NUL stdin, node/python scripts, child-only env');
}finally{await client.close();await server.close();}
process.exit(0);

