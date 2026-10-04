// The real "obsidian" package has types only. Tests never construct
// Obsidian classes; this keeps accidental imports resolvable.
export const requestUrl = () => {
	throw new Error("requestUrl is mocked in tests");
};
export class TFile {}
export class TFolder {}
export const normalizePath = (path: string) => path;
