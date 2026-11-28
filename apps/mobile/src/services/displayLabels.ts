const labels: Record<string, string> = {
  owner: '所有者', admin: '管理员', member: '成员', guest: '访客',
  active: '活跃', idle: '空闲', running: '运行中', pending: '等待中',
  waiting: '等待中', ready: '就绪', closed: '已关闭', stopped: '已停止',
  completed: '已完成', failed: '失败', disconnected: '已断开',
  online: '在线', offline: '离线', live: '进行中',
};

export function displayLabel(value: string): string {
  return labels[value.toLowerCase()] ?? value;
}
