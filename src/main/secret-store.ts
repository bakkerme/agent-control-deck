import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface SecretEncryption {
  available(): boolean;
  encrypt(value: string): Buffer | Promise<Buffer>;
  decrypt(value: Buffer): string | Promise<string>;
}
// The renderer can write/replace or remove a key, but can never retrieve one.
export class SecretStore {
  constructor(private file: string, private encryption: SecretEncryption) {}
  available(): boolean { return this.encryption.available(); }
  hasKey(): boolean { return existsSync(this.file); }
  async save(key: string): Promise<void> {
    if (!this.available()) throw new Error("Secure key storage is unavailable on this computer. No key was saved.");
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const encrypted = await this.encryption.encrypt(key);
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(temporary, encrypted, { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      throw new Error("Could not securely save the API key. The previous saved key was kept.");
    } finally {
      if (existsSync(temporary)) { try { unlinkSync(temporary); } catch { /* Ciphertext only. */ } }
    }
  }
  async read(): Promise<string> {
    if (!this.available()) throw new Error("Secure key storage is unavailable on this computer.");
    if (!this.hasKey()) throw new Error("Add an API key for the selected service in Settings.");
    try {
      const info = statSync(this.file);
      if (!info.isFile() || info.size > 131072) throw new Error("Invalid credential file");
      return await this.encryption.decrypt(readFileSync(this.file));
    }
    catch { throw new Error("Could not unlock the saved API key. Replace it in Settings."); }
  }
  remove(): void {
    try { if (this.hasKey()) unlinkSync(this.file); }
    catch { throw new Error("Could not remove the saved API key."); }
  }
}
