import fs from 'node:fs/promises';
import path from 'node:path';

const FORBIDDEN = /(^|\/)\.\.(\/|$)/;

/**
 * Normalise un chemin renvoye par un modele : separateurs unix, sans `./` ni
 * `/` de tete. Les fichiers caches (`.gitignore`, `.github/workflows/ci.yml`)
 * doivent survivre a cette normalisation — ne jamais retirer le point initial.
 */
export function normalizeRelPath(input: string): string {
  return input.replace(/\\/g, '/').trim().replace(/^(?:\.\/|\/)+/, '');
}

/**
 * Espace de travail d'un projet genere. Toutes les ecritures sont contraintes
 * a l'interieur du repertoire racine : un modele qui renverrait un chemin
 * `../../.ssh/authorized_keys` est rejete, pas execute.
 */
export class Workspace {
  constructor(readonly root: string) {}

  static async create(root: string): Promise<Workspace> {
    await fs.mkdir(root, { recursive: true });
    return new Workspace(path.resolve(root));
  }

  /** Normalise et valide un chemin relatif venant du modele. */
  resolve(relative: string): string {
    const cleaned = normalizeRelPath(relative);
    if (!cleaned) throw new Error('chemin de fichier vide');
    if (FORBIDDEN.test(cleaned)) throw new Error(`chemin non autorise: ${relative}`);
    if (path.isAbsolute(cleaned)) throw new Error(`chemin absolu refuse: ${relative}`);

    const target = path.resolve(this.root, cleaned);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (target !== this.root && !target.startsWith(rootWithSep)) {
      throw new Error(`chemin hors de l'espace de travail: ${relative}`);
    }
    return target;
  }

  async write(relative: string, content: string): Promise<number> {
    const target = this.resolve(relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    return Buffer.byteLength(content, 'utf8');
  }

  async read(relative: string): Promise<string> {
    return fs.readFile(this.resolve(relative), 'utf8');
  }

  async tryRead(relative: string): Promise<string | undefined> {
    try {
      return await this.read(relative);
    } catch {
      return undefined;
    }
  }

  async exists(relative: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(relative));
      return true;
    } catch {
      return false;
    }
  }

  /** Supprime un fichier du projet. Le depot git lui-meme est intouchable. */
  async remove(relative: string): Promise<boolean> {
    const cleaned = normalizeRelPath(relative);
    if (cleaned === '.git' || cleaned.startsWith('.git/')) {
      throw new Error('suppression refusee dans .git');
    }
    const target = this.resolve(cleaned);
    try {
      await fs.rm(target, { recursive: false, force: false });
      return true;
    } catch {
      return false;
    }
  }

  /** Taille en octets, ou undefined si le fichier n'existe pas. */
  async size(relative: string): Promise<number | undefined> {
    try {
      return (await fs.stat(this.resolve(relative))).size;
    } catch {
      return undefined;
    }
  }

  async chmod(relative: string, mode: number): Promise<void> {
    await fs.chmod(this.resolve(relative), mode);
  }

  /** Liste recursive des fichiers, en excluant les dossiers lourds. */
  async list(ignore = ['node_modules', '.git', 'dist', 'build', '.next', 'target', 'venv', '__pycache__']): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (ignore.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) out.push(path.relative(this.root, full).split(path.sep).join('/'));
      }
    };
    await walk(this.root);
    return out.sort();
  }
}
