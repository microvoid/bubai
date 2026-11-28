import { expect, test } from 'bun:test';
import { reconcileTimeline, type LocalMessage } from '../../apps/mobile/src/store/reconcileTimeline';

const item = (id:string, content:string):LocalMessage => ({id,content,channelId:'room',senderId:'u',senderRole:'human',createdAt:1});

test('an older history response cannot remove a queued send acknowledged during reconnect', () => {
  const root = item('root','root');
  const sent = item('sent','queued offline');
  expect(reconcileTimeline([root], [root,{...sent,delivery:'queued'}], [root,sent])).toEqual([root,sent]);
});

test('concurrent edit, deletion and creation survive history refresh; confirmed pending rows converge', () => {
  const a = item('a','old'), b = item('b','deleted'), c = item('c','new'), d=item('d','pending');
  const edit = {...a,content:'edited'};
  expect(reconcileTimeline([a,b,d],[a,b],[edit,c,{...d,delivery:'sending'}])).toEqual([edit,d,c]);
});
