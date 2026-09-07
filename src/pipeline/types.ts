/** Description d'un fichier a produire, telle que planifiee par le modele. */
export interface FileSpec {
  path: string;
  /** Ce que le fichier doit contenir, en une a trois phrases. */
  purpose: string;
  /** Chemins dont le contenu est necessaire pour ecrire celui-ci. */
  dependsOn: string[];
  /** 1 = trivial (config, .gitignore), 5 = logique metier centrale. */
  complexity: number;
  /** Interfaces/exports que les autres fichiers attendent de celui-ci. */
  exports?: string[];
}

export interface Commands {
  install?: string;
  build?: string;
  test?: string;
  lint?: string;
  start?: string;
  dev?: string;
}

/** Plan complet d'une application, produit par la phase de planification. */
export interface AppSpec {
  name: string;
  slug: string;
  summary: string;
  /** Ex. "TypeScript + Node + Fastify + SQLite". */
  stack: string;
  language: string;
  /** Ex. "node", "python", "static", "go". */
  runtime: string;
  features: string[];
  files: FileSpec[];
  commands: Commands;
  /** Variables d'environnement attendues par l'application generee. */
  env: Array<{ name: string; description: string; required: boolean }>;
  notes?: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
  bytes: number;
  ms: number;
}

export interface VerificationStep {
  name: string;
  command: string;
  code: number;
  ms: number;
  output: string;
  ok: boolean;
}

export interface VerificationReport {
  ran: boolean;
  ok: boolean;
  steps: VerificationStep[];
  /** Sortie condensee des etapes en echec, injectee dans la reparation. */
  failureDigest: string;
}

export interface BuildResult {
  spec: AppSpec;
  projectDir: string;
  files: GeneratedFile[];
  verification: VerificationReport;
  repairAttempts: number;
  ms: number;
  usage: {
    requests: number;
    cacheHits: number;
    inputTokens: number;
    outputTokens: number;
  };
  repo?: {
    url: string;
    cloneUrl: string;
    owner: string;
    name: string;
    branch: string;
  };
}

export interface BuildOptions {
  /** Demande en langage naturel. */
  prompt: string;
  /** Force le nom du projet (sinon derive du plan). */
  name?: string;
  /** Force la pile technique. */
  stack?: string;
  /** Repertoire de sortie (sinon `<workspace>/<slug>`). */
  outDir?: string;
  /** Desactive install/build/test. */
  verify?: boolean;
  /** Nombre de boucles de reparation. 0 = illimite. */
  maxRepairAttempts?: number;
  /** Publie sur GitHub a la fin. */
  github?: boolean;
  repoName?: string;
  repoPrivate?: boolean;
  repoOwner?: string;
  /** Ajoute un workflow GitHub Actions au projet genere. */
  withCi?: boolean;
  /** Force un fournisseur de modeles. */
  provider?: string;
  signal?: AbortSignal;
}
