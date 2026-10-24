import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { authApi } from '@/lib/authApi';
import { USERS_QUERY_KEY } from '@/lib/queryClient';
import type { SessionUser, UserCreateInput, UserUpdateInput } from '@/types/user';

const USERS_STALE_TIME = 30_000;

export function useUsers(): UseQueryResult<readonly SessionUser[]> {
  return useQuery({
    queryKey: USERS_QUERY_KEY,
    queryFn: () => authApi.listUsers().then((result) => result.users),
    staleTime: USERS_STALE_TIME,
  });
}

/** Dopo una mutazione la lista viene riletta: niente merge manuale fragile. */
function invalidateUsers(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
}

export function useCreateUser(): UseMutationResult<
  SessionUser,
  Error,
  UserCreateInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UserCreateInput) =>
      authApi.createUser(input).then((result) => result.user),
    onSuccess: async () => {
      await invalidateUsers(queryClient);
    },
  });
}

export function useUpdateUser(): UseMutationResult<
  SessionUser,
  Error,
  { id: string; input: UserUpdateInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }) => authApi.updateUser(id, input).then((result) => result.user),
    onSuccess: async () => {
      await invalidateUsers(queryClient);
    },
  });
}

export function useDeleteUser(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authApi.deleteUser(id),
    onSuccess: async () => {
      await invalidateUsers(queryClient);
    },
  });
}
