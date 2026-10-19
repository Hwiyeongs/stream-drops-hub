import { progressLabel } from '../src/services/reward-progress.js';

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  element.className = className;
  if (text != null) element.textContent = text;
  return element;
};
function meter(percent, label) {
  const track = node('div', 'collection-meter' + (percent === null ? ' unknown' : ''));
  track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', label);
  track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
  if (percent !== null) track.setAttribute('aria-valuenow', String(percent));
  track.setAttribute('aria-valuetext', percent === null ? '확인 대기' : percent + '%');
  const fill = node('span', 'collection-meter-fill');
  fill.style.width = (percent ?? 0) + '%'; track.append(fill);
  return track;
}
function checkedLabel(at) {
  return at ? new Date(at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
}
export function renderCollectionProgress(container, rows) {
  const keep = new Set(rows.map(row => row.platform));
  for (const details of [...container.children]) if (!keep.has(details.dataset.platform)) details.remove();
  for (const row of rows) {
    let details = [...container.children].find(item => item.dataset.platform === row.platform);
    if (!details) {
      details = node('details', 'collection-progress'); details.dataset.platform = row.platform;
      details.append(node('summary', 'collection-progress-summary'), node('div', 'collection-progress-rewards'));
      container.append(details);
    }
    details.classList.toggle('previous-progress', row.stale);
    const summary = details.querySelector('summary');
    summary.setAttribute('aria-label', `${row.name} ${row.title} ${row.percent === null ? '확인 대기' : '다음 보상 ' + row.percent + '%'} · 보상별 진행률 펼치기`);
    const heading = node('div', 'collection-progress-heading');
    heading.append(node('span', 'collection-platform', row.name));
    const title = node('span', 'collection-campaign', row.title); title.title = row.title;
    heading.append(title, node('span', 'collection-percent', row.percent === null ? '확인 대기' : (row.next ? '다음 ' : '') + row.percent + '%'));
    const caption = node('div', 'collection-progress-caption');
    caption.append(node('span', '', row.label), node('span', '', row.total ? `보상 ${row.earned}/${row.total}개 달성` : '서버 진행 확인 중'));
    const summaryNodes = [heading, meter(row.percent, row.name + ' 다음 보상 진행률'), caption];
    const notes = [row.status, row.stale ? '이전 조회 기준' : '', row.partial ? '일부 조회 재시도 중' : ''].filter(Boolean);
    if (notes.length) summaryNodes.push(node('div', 'collection-progress-note', notes.join(' · ') + (row.checkedAt ? ' · ' + checkedLabel(row.checkedAt) : '')));
    summary.replaceChildren(...summaryNodes);
    const body = details.querySelector('.collection-progress-rewards');
    const sections = row.campaigns.map(campaign => {
      const section = node('section', 'collection-campaign-rewards');
      const heading = node('div', 'collection-rewards-title', campaign.title); heading.title = campaign.title;
      section.append(heading);
      if (campaign.stale) section.append(node('div', 'collection-progress-note', '이전 조회 기준' + (campaign.checkedAt ? ' · ' + checkedLabel(campaign.checkedAt) : '')));
      if (!campaign.rewards.length) section.append(node('p', 'collection-progress-note', '보상별 진행 확인 대기'));
      campaign.rewards.forEach((reward, index) => {
        const item = node('div', 'collection-reward');
        item.dataset.state = reward.state;
        const name = node('span', 'collection-reward-name', `${index + 1}. ${reward.name}`); name.title = reward.name;
        const label = progressLabel(reward);
        const value = node('span', 'collection-reward-value', label + (reward.state === 'watching' ? ' · ' + reward.percent + '%' : ''));
        item.append(name, value, meter(reward.percent, reward.name + ' 진행률')); section.append(item);
      });
      return section;
    });
    body.replaceChildren(...sections, node('p', 'collection-progress-note', '서버 기준 · 약 1분마다 갱신 · 100%는 시청 조건 달성'));
  }
  container.classList.toggle('hidden', !rows.length);
}
