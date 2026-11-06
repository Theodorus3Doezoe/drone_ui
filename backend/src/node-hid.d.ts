declare module "node-hid" {
  export class HID {
    constructor(path: string);
    on(event: string, cb: (data: Buffer) => void): void;
    close(): void;
  }
}
