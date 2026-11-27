import { useQuery } from '@tanstack/react-query';
import { useBubai } from './BubaiProvider';

export function useActivity() {
  const { client, serverUrl, activeOrgId, currentUserId } = useBubai();
  return useQuery({
    queryKey: ['activity', serverUrl, activeOrgId, currentUserId],
    enabled: Boolean(client && currentUserId),
    queryFn: () => client!.getActivity(currentUserId),
  });
}
