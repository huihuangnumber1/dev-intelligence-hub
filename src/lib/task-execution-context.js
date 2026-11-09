import { AsyncLocalStorage } from 'node:async_hooks';

// Process-private execution context; browser/model inputs cannot create handles.
const execution = new AsyncLocalStorage();
export const currentTaskExecution = () => execution.getStore() ?? null;
export const withTaskExecution = (context, operation) => execution.run(context, operation);

export function taskInstructionMessages(instructions = []) {
  if (!Array.isArray(instructions) || instructions.length > 20 || instructions.some(
    (text) => typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 4000,
  )) throw new TypeError('Task instructions are invalid');
  return instructions.length ? [{ role:'user', content:
    'Owner supplemental requirements for this same task, in chronological order; newer requirements supersede conflicting earlier requirements. Existing permissions, source bindings and required verification remain authoritative.\n' + instructions.join('\n\n') }] : [];
}
