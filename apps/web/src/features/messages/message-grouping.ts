/**
 * Message grouping rules ported from references/buzz-app/src/features/messages/message-grouping.ts,
 * thinly adapted for our ChatMessage data shape (ms or s timestamps).
 */
import { calendarDay, toUnixSeconds } from '../../shared/datetime';

export interface GroupableMessage {
  channelId: string;
  senderId: string;
  senderRole: 'human' | 'agent';
  createdAt: number;
}

export function continuesMessageGroup(
  previous: GroupableMessage | undefined,
  current: GroupableMessage,
): boolean {
  if (!previous) return false;
  const prevSec = toUnixSeconds(previous.createdAt);
  const currSec = toUnixSeconds(current.createdAt);
  return (
    previous.channelId === current.channelId &&
    previous.senderId === current.senderId &&
    previous.senderRole === current.senderRole &&
    currSec >= prevSec &&
    currSec - prevSec <= 5 * 60 &&
    calendarDay(prevSec) === calendarDay(currSec)
  );
}
