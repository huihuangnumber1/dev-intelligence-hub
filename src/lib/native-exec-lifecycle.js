import {StringDecoder} from 'node:string_decoder';
import {parseJsonWithUniqueKeys} from './strict-json.js';

// Observe protocol types without copying conversation text into runtime receipts.
export function createNativeExecLifecycle(context,input) {
  const decoder=new StringDecoder('utf8');
  let buffer='',dropping=false,open=true;
  return {
    duplex:{
      onReady(control) { if(!open)return;control.write(input);control.end(); },
      onOutput({stream,chunk}) {
        if(!open || stream!=='stdout')return;
        buffer+=decoder.write(chunk);
        let end;
        while((end=buffer.indexOf('\n'))>=0) {
          const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
          if(dropping){dropping=false;continue;}
          if(Buffer.byteLength(line)>64*1024)continue;
          let event;
          try {event=parseJsonWithUniqueKeys(line);}catch {continue;}
          if(event?.type==='turn.started')context?.reportModelState?.('running');
          if(typeof event?.type==='string')context?.reportActivity?.();
        }
        if(Buffer.byteLength(buffer)>64*1024){buffer='';dropping=true;}
      },
    },
    close(){open=false;buffer='';},
  };
}
