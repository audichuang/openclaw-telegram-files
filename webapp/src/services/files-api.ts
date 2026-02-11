/** HTTP REST client for the file system API. */

export type FileItem = {
  name: string;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
};

export type LsResult = {
  path: string;
  items: FileItem[];
};

export type ReadResult = {
  path: string;
  content: string;
  size: number;
};

export class FilesApiClient {
  private token: string;
  private baseUrl: string;

  constructor(token: string) {
    this.token = token;
    this.baseUrl = `${window.location.origin}/plugins/telegram-files/api`;
  }

  private async request(method: string, endpoint: string, body?: unknown): Promise<unknown> {
    const opts: RequestInit = {
      method,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(`${this.baseUrl}${endpoint}`, opts);
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error((data as { error?: string }).error ?? `HTTP ${resp.status}`);
    }
    return data;
  }

  async ls(dirPath: string): Promise<LsResult> {
    const encoded = encodeURIComponent(dirPath);
    return (await this.request("GET", `/ls?path=${encoded}`)) as LsResult;
  }

  async read(filePath: string): Promise<ReadResult> {
    const encoded = encodeURIComponent(filePath);
    return (await this.request("GET", `/read?path=${encoded}`)) as ReadResult;
  }

  async write(filePath: string, content: string): Promise<void> {
    await this.request("POST", "/write", { path: filePath, content });
  }

  async delete(targetPath: string): Promise<void> {
    const encoded = encodeURIComponent(targetPath);
    await this.request("DELETE", `/delete?path=${encoded}`);
  }
}
