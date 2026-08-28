export interface FirebaseIdentity {
  firebaseUid: string;
  nome: string | null;
  email: string;
  fotoUrl: string | null;
  emailVerified: boolean;
}
