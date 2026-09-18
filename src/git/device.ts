/**
 * Connexion a GitHub sans coller de cle : le « device flow » d'OAuth.
 *
 * C'est exactement ce que font `gh auth login` et les assistants de codage :
 * on demande un code court, l'utilisateur le tape sur github.com, et GitHub
 * nous remet un jeton. Rien a copier, rien a coller, aucun secret dans le
 * code — le `client_id` d'une application OAuth est public par construction.
 *
 * Une precision qui compte : les deux points d'entree du device flow vivent
 * sur `github.com`, pas sur `api.github.com`, et ils ne renvoient pas d'en-tete
 * CORS. Une page servie depuis un domaine tiers ne peut donc pas les appeler
 * elle-meme : il faut un processus. C'est ce que fournit `forge login` en
 * ligne de commande, et ce que relaie `forge serve` pour l'interface web.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Ou GitHub heberge le device flow (surchargeable pour GitHub Enterprise). */
const BASE = (process.env['GITHUB_SERVER_URL'] ?? 'https://github.com').replace(/\/+$/, '');

/**
 * Droits demandes. `repo` couvre la creation et l'ecriture d'un depot ;
 * `workflow` permet de pousser un fichier `.github/workflows/`, ce que Forge
 * fait quand la CI est demandee.
 */
export const DEFAULT_SCOPE = 'repo workflow';

export interface DeviceStart {
  /** Le code a taper sur github.com, du genre `ABCD-1234`. */
  userCode: string;
  /** L'adresse ou le taper. */
  verificationUri: string;
  /** Identifiant opaque, a renvoyer a chaque sondage. */
  deviceCode: string;
  /** Delai minimal entre deux sondages, en secondes. */
  interval: number;
  /** Duree de validite du code, en secondes. */
  expiresIn: number;
}

export type PollResult =
  | { status: 'pending'; interval: number }
  | { status: 'granted'; token: string; scope: string }
  | { status: 'denied' }
  | { status: 'expired' };

export class DeviceFlowError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DeviceFlowError';
  }
}

/** Messages lisibles pour ce que GitHub sait refuser. */
function explain(code: string, fallback: string): string {
  switch (code) {
    case 'unauthorized_client':
      return "Cette application OAuth n'a pas le device flow active. Ouvrez ses reglages sur GitHub et cochez « Enable Device Flow ».";
    case 'invalid_client':
      return "Identifiant d'application (client_id) inconnu de GitHub.";
    case 'device_flow_disabled':
      return 'Le device flow est desactive pour cette application OAuth.';
    default:
      return fallback || `GitHub a refuse : ${code}`;
  }
}

async function form(
  url: string,
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, string>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  } catch (error) {
    throw new DeviceFlowError(
      `Impossible de joindre ${new URL(url).host} : ${(error as Error).message}`,
      'network',
    );
  }

  const text = await response.text();
  let payload: Record<string, string>;
  try {
    payload = JSON.parse(text) as Record<string, string>;
  } catch {
    // GitHub repond parfois en texte quand la requete est malformee.
    throw new DeviceFlowError(
      `Reponse inattendue de GitHub (${response.status}) : ${text.slice(0, 200)}`,
      'malformed',
    );
  }
  return payload;
}

/** Premiere etape : obtenir le code que l'utilisateur ira taper. */
export async function startDeviceFlow(
  clientId: string,
  options: { scope?: string; fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<DeviceStart> {
  if (!clientId) {
    throw new DeviceFlowError(
      "Aucun identifiant d'application OAuth. Voir `forge login --aide`.",
      'no_client_id',
    );
  }
  const payload = await form(
    `${options.baseUrl ?? BASE}/login/device/code`,
    { client_id: clientId, scope: options.scope ?? DEFAULT_SCOPE },
    options.fetchImpl ?? fetch,
  );

  if (payload['error']) {
    throw new DeviceFlowError(
      explain(payload['error'], payload['error_description'] ?? ''),
      payload['error'],
    );
  }
  if (!payload['device_code'] || !payload['user_code']) {
    throw new DeviceFlowError('GitHub n’a pas renvoye de code de connexion.', 'malformed');
  }

  return {
    userCode: payload['user_code'],
    verificationUri: payload['verification_uri'] ?? `${BASE}/login/device`,
    deviceCode: payload['device_code'],
    interval: Number(payload['interval'] ?? 5) || 5,
    expiresIn: Number(payload['expires_in'] ?? 900) || 900,
  };
}

/**
 * Deuxieme etape : un sondage. Tant que l'utilisateur n'a pas valide, GitHub
 * repond `authorization_pending` — ce n'est pas une erreur, c'est l'attente.
 */
export async function pollDeviceFlow(
  clientId: string,
  deviceCode: string,
  options: { fetchImpl?: typeof fetch; baseUrl?: string; interval?: number } = {},
): Promise<PollResult> {
  const payload = await form(
    `${options.baseUrl ?? BASE}/login/oauth/access_token`,
    {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    },
    options.fetchImpl ?? fetch,
  );

  const interval = options.interval ?? 5;
  const erreur = payload['error'];

  if (!erreur && payload['access_token']) {
    return { status: 'granted', token: payload['access_token'], scope: payload['scope'] ?? '' };
  }
  switch (erreur) {
    case 'authorization_pending':
      return { status: 'pending', interval };
    // GitHub demande de ralentir : il impose +5 s, et le dit.
    case 'slow_down':
      return { status: 'pending', interval: Number(payload['interval'] ?? interval + 5) || interval + 5 };
    case 'expired_token':
      return { status: 'expired' };
    case 'access_denied':
      return { status: 'denied' };
    default:
      throw new DeviceFlowError(
        explain(erreur ?? '', payload['error_description'] ?? ''),
        erreur ?? 'unknown',
      );
  }
}

/**
 * La boucle complete : demarre, puis sonde jusqu'a la reponse de l'utilisateur.
 * `onCode` est appele une fois, des que le code est connu, pour l'afficher.
 */
export async function login(
  clientId: string,
  options: {
    scope?: string;
    onCode?: (start: DeviceStart) => void;
    fetchImpl?: typeof fetch;
    baseUrl?: string;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<{ token: string; scope: string }> {
  const start = await startDeviceFlow(clientId, options);
  options.onCode?.(start);

  const attendre = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maintenant = options.now ?? (() => Date.now());
  const limite = maintenant() + start.expiresIn * 1000;
  let interval = start.interval;

  while (maintenant() < limite) {
    await attendre(interval * 1000);
    const verdict = await pollDeviceFlow(clientId, start.deviceCode, { ...options, interval });
    if (verdict.status === 'granted') return { token: verdict.token, scope: verdict.scope };
    if (verdict.status === 'denied') {
      throw new DeviceFlowError('Connexion refusee sur GitHub.', 'access_denied');
    }
    if (verdict.status === 'expired') {
      throw new DeviceFlowError('Le code a expire. Relancez la connexion.', 'expired_token');
    }
    interval = verdict.interval;
  }
  throw new DeviceFlowError('Le code a expire. Relancez la connexion.', 'expired_token');
}

// --------------------------------------------------------------------------- //
// Ou le jeton est garde
// --------------------------------------------------------------------------- //
export interface StoredCredentials {
  /** Absent quand on s'est deconnecte : l'application, elle, reste connue. */
  token?: string;
  login?: string;
  scope?: string;
  clientId?: string;
  obtainedAt?: string;
}

export function credentialsPath(home: string): string {
  return path.join(home, 'github.json');
}

/**
 * Lit ce qui est enregistre, ou undefined. Ne leve jamais.
 *
 * Le fichier peut ne contenir que l'identifiant d'application, sans jeton :
 * c'est l'etat apres une deconnexion, et il faut le rendre tel quel — sinon il
 * faudrait recoller cet identifiant a chaque fois. Un jeton vide est ramene a
 * `undefined` pour que le reste du code n'ait qu'un cas d'absence a traiter.
 */
export function readCredentials(home: string): StoredCredentials | undefined {
  try {
    const brut = JSON.parse(fs.readFileSync(credentialsPath(home), 'utf8')) as StoredCredentials;
    if (!brut || typeof brut !== 'object') return undefined;
    const token = typeof brut.token === 'string' && brut.token ? brut.token : undefined;
    if (!token && !brut.clientId) return undefined;
    return { ...brut, token };
  } catch {
    return undefined;
  }
}

/**
 * Enregistre le jeton, lisible par le seul proprietaire.
 *
 * Le mode est pose a l'ouverture ET apres coup : un fichier qui existait deja
 * garderait sinon ses anciens droits, et `mode` est ignore dans ce cas.
 */
export function writeCredentials(home: string, creds: StoredCredentials): string {
  fs.mkdirSync(home, { recursive: true });
  const cible = credentialsPath(home);
  // Un jeton vide ne s'ecrit pas : l'absence se dit par l'absence.
  const propre: StoredCredentials = { ...creds };
  if (!propre.token) delete propre.token;
  fs.writeFileSync(cible, `${JSON.stringify(propre, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(cible, 0o600);
  } catch {
    // Systeme de fichiers sans droits POSIX : rien a faire, et rien de grave.
  }
  return cible;
}

/** Efface le jeton enregistre. Renvoie vrai s'il y avait quelque chose. */
export function clearCredentials(home: string): boolean {
  try {
    fs.unlinkSync(credentialsPath(home));
    return true;
  } catch {
    return false;
  }
}
