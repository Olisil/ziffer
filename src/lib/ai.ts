// AI traffic: visits sent by an AI assistant (a person clicked a link in an answer), and AI agents
// that open the site themselves on someone's behalf. Crawlers that only fetch the HTML never run
// the snippet, so they can't be seen here.
const ASSISTANTS: [RegExp, string][] = [
  [/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$|^chatgpt|^openai/, 'ChatGPT'],
  [/(^|\.)perplexity\.ai$|^perplexity/, 'Perplexity'],
  [/(^|\.)claude\.ai$|^claude/, 'Claude'],
  [/^gemini\.google\.com$|^gemini/, 'Gemini'],
  [/(^|\.)copilot\.microsoft\.com$|^copilot/, 'Copilot'],
  [/(^|\.)mistral\.ai$|^mistral|^lechat/, 'Le Chat'],
  [/(^|\.)deepseek\.com$|^deepseek/, 'DeepSeek'],
  [/(^|\.)grok\.com$|^grok/, 'Grok'],
  [/(^|\.)meta\.ai$|^meta\.?ai/, 'Meta AI'],
  [/(^|\.)you\.com$/, 'You.com'],
  [/(^|\.)phind\.com$|^phind/, 'Phind'],
  [/(^|\.)duck\.ai$/, 'Duck.ai'],
];
/** The assistant behind a referrer host or a utm_source value, if it is one we know. */
export function assistantOf(v: string | null | undefined): string | null {
  const s = (v || '').trim().toLowerCase();
  if (!s) return null;
  for (const [re, name] of ASSISTANTS) if (re.test(s)) return name;
  return null;
}
const AGENTS: [RegExp, string][] = [
  [/ChatGPT-User|ChatGPT Agent|OpenAI.?Operator/i, 'ChatGPT'],
  [/Claude-User|Claude-Web|Claude-SearchBot/i, 'Claude'],
  [/Perplexity-User|Perplexity-Comet/i, 'Perplexity'],
  [/MistralAI-User/i, 'Le Chat'],
  [/Gemini-Deep-Research|Google-Agent|Google-NotebookLM/i, 'Gemini'],
  [/Manus-User/i, 'Manus'],
  [/Devin/i, 'Devin'],
];
/** The AI agent a browser says it is, from its user agent. */
export function agentOf(ua: string): string | null {
  for (const [re, name] of AGENTS) if (re.test(ua)) return name;
  return null;
}
