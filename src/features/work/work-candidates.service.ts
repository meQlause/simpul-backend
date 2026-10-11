import { selectCandidates } from './work-candidates.repository.js';

export async function candidateWork(...parameters: Parameters<typeof selectCandidates>) {
  return selectCandidates(...parameters);
}
