import { triageClass, triageOutput } from './understanding.schema.js';

// The JSON answer carries the day the message refers to; a plain one-word answer still works, with no day.
export function readTriage(output: string) {
  const text = output.trim();

  if (!text.startsWith('{')) {
    return { triageClass: triageClass.parse(text), referencedDate: null };
  }

  const answer = triageOutput.parse(JSON.parse(text));

  return { triageClass: answer.class, referencedDate: answer.referencedDate };
}
