declare global {
  namespace App {
    interface Locals { user?: { id: string; name: string; username: string | null; email: string; role: string; enabled: boolean; approved: boolean; emailVerified?: boolean } | null }
  }
}
export {};
