import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";

const contextName = /^c_[a-f0-9]{24}$/;
const generationName = /^[a-f0-9]{16}$/;

/** 控制面生成的临时文件；用户 home、workspace、任务和 SDK 记录不属于这里。 */
export class ExecutionArtifacts {
  readonly projections: string;
  readonly wrappers: string;
  constructor(root: string) {
    this.projections = join(root, "execution", "projections");
    this.wrappers = join(root, "execution", "wrappers");
  }
  projection(contextId: string, generation: string): string {
    if (!contextName.test(contextId) || !generationName.test(generation)) throw new Error("运行实例标识无效");
    return join(this.projections, contextId, generation);
  }
  removeProjection(contextId: string, generation: string): void {
    const target = this.projection(contextId, generation);
    const context = join(this.projections, contextId);
    if (!this.directory(this.projections) || !this.directory(context)) return;
    rmSync(target, { recursive: true, force: true });
    this.removeEmpty(context);
  }
  removeWrapper(contextId: string): void {
    if (!contextName.test(contextId)) throw new Error("上下文标识无效");
    if (this.directory(this.wrappers)) rmSync(join(this.wrappers, `${contextId}.sh`), { force: true });
  }
  collect(protectedContexts: ReadonlySet<string>): void {
    if (this.directory(this.projections)) for (const context of readdirSync(this.projections, { withFileTypes: true })) {
      // 不跟随目录软链，也不处置不认识的文件。
      if (!context.isDirectory() || !contextName.test(context.name) || protectedContexts.has(context.name)) continue;
      const parent = join(this.projections, context.name);
      for (const version of readdirSync(parent, { withFileTypes: true })) {
        if (generationName.test(version.name) && (version.isDirectory() || version.isSymbolicLink())) {
          rmSync(join(parent, version.name), { recursive: true, force: true });
        }
      }
      this.removeEmpty(parent);
    }
    if (this.directory(this.wrappers)) for (const entry of readdirSync(this.wrappers, { withFileTypes: true })) {
      const id = entry.name.slice(0, -3);
      if (entry.name.endsWith(".sh") && contextName.test(id) && !protectedContexts.has(id) && !entry.isDirectory()) this.removeWrapper(id);
    }
  }
  private directory(path: string): boolean {
    return existsSync(path) && lstatSync(path).isDirectory();
  }
  private removeEmpty(path: string): void {
    try { rmdirSync(path); }
    catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
}
