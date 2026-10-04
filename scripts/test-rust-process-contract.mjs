import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
process.env.MCP_LOCAL_ENGINE_URL = process.env.CONTRACT_ENGINE_URL ?? 'http://127.0.0.1:3565/mcp';
const {createServer} = await import('../dist/server.js');
const server=createServer('rust-contract-fixture');
const client=new Client({name:'rust-contract-fixture',version:'1'});
const [a,b]=InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a),client.connect(b)]);
const owned=new Set();
async function call(name,args){const r=await client.callTool({name,arguments:args});assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent;}
const activity_target={type:'card',id:'contract-roundtrip',project:'fixture'};
try {
  const missing=await call('start_process',{executable:'mcp_missing_executable_contract_fixture_20261004',activity_target,wait_ms:1000});
  assert.equal(missing.process_state,'COMPLETED');assert.equal(missing.next_action,'STOP_READING');
  assert.equal(missing.failure_diagnostic.kind,'spawn_error');assert.equal(missing.failure_diagnostic.code,'ENOENT');
  assert.deepEqual(missing.activity_target,activity_target);
  const repeat=await call('read_output',{process_id:missing.process_id});assert.deepEqual(repeat.activity_target,activity_target);
  assert.equal(repeat.failure_diagnostic.kind,'spawn_error');
  await Promise.all(Array.from({length:6},async (_,trial) => {
    const units=120000;
    let v=await call('start_process',{executable:process.execPath,args:['-e',`process.stdout.write('a😀'.repeat(${units}));process.stderr.write('ERROR'.repeat(10001));`],activity_target,wait_ms:0});
    owned.add(v.process_id);let out='',err='',lastOut=0,lastErr=0,maxOut=0,maxErr=0,reads=0;
    const end=Date.now()+20000;
    while(true){
      assert.deepEqual(v.activity_target,activity_target);
      const p=v.output_page;
      assert.equal(p.stdout_start,lastOut);assert.equal(p.stderr_start,lastErr);
      assert.equal(p.stdout_end-p.stdout_start,v.stdout.length);assert.equal(p.stderr_end-p.stderr_start,v.stderr.length);
      assert.ok(p.stdout_total>=p.stdout_end);assert.ok(p.stderr_total>=p.stderr_end);
      assert.ok(p.stdout_total>=maxOut);assert.ok(p.stderr_total>=maxErr);
      out+=v.stdout;err+=v.stderr;lastOut=p.stdout_end;lastErr=p.stderr_end;maxOut=p.stdout_total;maxErr=p.stderr_total;
      if(v.next_action==='STOP_READING')break;
      assert.ok(Date.now()<end,'fixture deadline');v=await call('read_output',{process_id:v.process_id,max_chars:997,wait_ms:1000});reads++;
    }
    assert.equal(out,'a😀'.repeat(units));assert.equal(err,'ERROR'.repeat(10001));
    assert.equal(v.output_page.stdout_total,units*3);assert.equal(v.output_page.stderr_total,50005);assert.ok(reads>10);
    owned.delete(v.process_id);
  }));
  console.log(JSON.stringify({result:'PASS',spawn_failure_structured:true,activity_roundtrip:true,authoritative_cumulative_pages:true,unicode_utf16_offsets:true,six_concurrent_finite_processes:true}));
}finally{for(const process_id of owned)await client.callTool({name:'kill_process',arguments:{process_id}});await client.close();await server.close();}
process.exit(0);
