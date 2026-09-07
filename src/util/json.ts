/**
 * Extraction robuste de JSON depuis une sortie de modele : les LLM entourent
 * souvent le JSON de prose ou de blocs de code, et laissent parfois des
 * virgules finales. Ces fonctions recuperent le maximum sans planter.
 */

function stripFences(text: string): string {
  const fence = /```(?:json|jsonc|json5)?\s*\n([\s\S]*?)\n?```/i.exec(text);
  return fence?.[1] ?? text;
}

/** Repere le premier objet/tableau JSON equilibre, en ignorant les chaines. */
function balancedSlice(text: string): string | undefined {
  const start = text.search(/[[{]/);
  if (start === -1) return undefined;
  const open = text[start] as '[' | '{';
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function repair(candidate: string): string {
  return candidate
    // virgules finales
    .replace(/,(\s*[}\]])/g, '$1')
    // commentaires de fin de ligne hors chaines (approximation prudente)
    .replace(/^\s*\/\/.*$/gm, '');
}

export function extractJson<T = unknown>(text: string): T | undefined {
  const candidates = [text, stripFences(text)];
  for (const raw of candidates) {
    const slice = balancedSlice(raw) ?? raw.trim();
    for (const attempt of [slice, repair(slice)]) {
      try {
        return JSON.parse(attempt) as T;
      } catch {
        /* on tente la variante suivante */
      }
    }
  }
  return undefined;
}

export function parseJsonOrThrow<T = unknown>(text: string, context = 'reponse'): T {
  const parsed = extractJson<T>(text);
  if (parsed === undefined) {
    throw new Error(`JSON illisible dans ${context}: ${text.slice(0, 400)}`);
  }
  return parsed;
}

/**
 * Extrait le contenu d'un fichier depuis une reponse de modele. On demande au
 * modele un bloc de code ; s'il n'y en a pas, on retombe sur le texte brut
 * nettoye de la prose d'introduction.
 */
export function extractCode(text: string): string {
  const blocks = [...text.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  if (blocks.length > 0) {
    // Le plus long bloc est presque toujours le fichier demande.
    return blocks.reduce((a, b) => (b.length > a.length ? b : a)).replace(/\n+$/, '\n');
  }
  return text.trim() + '\n';
}
