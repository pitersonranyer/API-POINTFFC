import { CartolaObservationSource } from '../src/point-fantasy/observation/observation-source';

describe('direct observation transport',()=>{
  const original=global.fetch;
  afterEach(()=>{global.fetch=original;jest.useRealTimers();});
  it('uses direct public GET and records only whitelisted headers',async()=>{
    const request=jest.fn(async()=>new Response('{"rodada":31}',{status:200,headers:{date:'test','cache-control':'max-age=180','set-cookie':'private','authorization':'private'}}));
    global.fetch=request;
    const row=await new CartolaObservationSource().get('/atletas/pontuados');
    expect(request).toHaveBeenCalledWith('https://api.cartola.globo.com/atletas/pontuados',expect.objectContaining({method:'GET',redirect:'error'}));
    expect(row.text).toBe('{"rodada":31}');expect(row.headers).toEqual({date:'test','cache-control':'max-age=180'});
  });
  it.each([400,404,500])('retains HTTP status and response %s',async status=>{
    global.fetch=jest.fn(async()=>new Response('{}',{status}));
    expect(await new CartolaObservationSource().get('/atletas/pontuados/30')).toMatchObject({status,text:'{}',error:`HTTP_${status}`});
  });
  it('sanitizes network failures',async()=>{
    global.fetch=jest.fn(async()=>{throw new Error('sensitive network details');});
    expect(await new CartolaObservationSource().get('/mercado/status')).toMatchObject({status:null,error:'PROVIDER_NETWORK'});
  });
  it('handles timeout without leaking errors',async()=>{
    jest.useFakeTimers();global.fetch=jest.fn((_url,options)=>new Promise((_resolve,reject)=>{
      options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')));
    }));
    const pending=new CartolaObservationSource().get('/mercado/status');await jest.advanceTimersByTimeAsync(15000);
    expect((await pending).error).toBe('PROVIDER_TIMEOUT');
  });
  it('rejects unapproved routes',async()=>{
    await expect(new CartolaObservationSource().get('/times/123')).rejects.toThrow('ENDPOINT_NOT_ALLOWED');
  });
  it('records body-read failure without leaking details',async()=>{
    global.fetch=jest.fn(async()=>new Response(new ReadableStream({pull(){throw new Error('private details');}})));
    expect((await new CartolaObservationSource().get('/atletas/pontuados')).error).toBe('PROVIDER_BODY_READ_FAILED');
  });
  it('rejects invalid UTF-8',async()=>{
    global.fetch=jest.fn(async()=>new Response(new Uint8Array([0xc3,0x28])));
    expect((await new CartolaObservationSource().get('/atletas/pontuados')).error).toBe('PROVIDER_INVALID_UTF8');
  });
  it('refuses oversized body',async()=>{
    global.fetch=jest.fn(async()=>new Response(new Uint8Array(8*1024*1024+1)));
    expect((await new CartolaObservationSource().get('/atletas/pontuados')).error).toBe('PAYLOAD_TOO_LARGE');
  });
});
