// Browser-safe configuration shapes. Runtime parsing and all secret-bearing
// server bindings live in env.server.ts so a component importing this DTO
// cannot pull Zod or the server schema into a route chunk.
export type SidebarLink = Readonly<{
  href: string;
  label: string;
  external: boolean;
}>;
