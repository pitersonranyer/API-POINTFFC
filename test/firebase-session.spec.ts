import { ForbiddenException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';

describe('Firebase session', () => {
  const firebase={verifyIdToken:jest.fn()}; const users={synchronizeVerifiedFirebase:jest.fn()}; const prisma:any={usuario:{findUnique:jest.fn()}}; const jwt={sign:jest.fn().mockReturnValue('jwt')}; const config={getOrThrow:jest.fn().mockReturnValue('1h')};
  const service=new AuthService(firebase as never,users as never,prisma,jwt as never,config as never);
  beforeEach(()=>jest.clearAllMocks());
  it('rejeita e-mail não confirmado antes de sincronizar',async()=>{firebase.verifyIdToken.mockResolvedValue({emailVerified:false});await expect(service.createFirebaseSession('token')).rejects.toBeInstanceOf(ForbiddenException);expect(users.synchronizeVerifiedFirebase).not.toHaveBeenCalled()});
  it('sincroniza identidade confirmada e emite JWT próprio',async()=>{const identity={firebaseUid:'uid',email:'user@test.com',emailVerified:true};const user={idUsuario:1,nome:'User',email:'user@test.com',fotoUrl:null,tipoUsuario:'PLAYER',status:'ATIVO'};firebase.verifyIdToken.mockResolvedValue(identity);users.synchronizeVerifiedFirebase.mockResolvedValue(user);await expect(service.createFirebaseSession('token')).resolves.toMatchObject({accessToken:'jwt',user:{email:'user@test.com'}});expect(users.synchronizeVerifiedFirebase).toHaveBeenCalledWith(identity)});
});
