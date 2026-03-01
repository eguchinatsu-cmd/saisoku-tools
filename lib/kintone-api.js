/**
 * kintone REST API クライアント
 */

/**
 * kintoneレコードを取得
 * @param {Object} config - { domain, appId, apiToken }
 * @param {'honsatei'|'konpokit'} queryType
 * @param {string} dateFormatted - "YYYY-MM-DD"
 * @returns {Promise<Array<{recordNumber: string, name: string, price: number}>>}
 */
export async function getKintoneRecords(config, queryType, dateFormatted) {
  let queryStr;
  if (queryType === 'honsatei') {
    queryStr = `progress in ("本査定完了") and ` +
      `更新日時 >= "${dateFormatted}T00:00:00+09:00" and ` +
      `更新日時 <= "${dateFormatted}T23:59:59+09:00"`;
  } else if (queryType === 'konpokit') {
    queryStr = `progress in ("梱包キット発送完了") and ` +
      `更新日時 >= "${dateFormatted}T00:00:00+09:00" and ` +
      `更新日時 <= "${dateFormatted}T23:59:59+09:00"`;
  } else {
    throw new Error(`Unknown query type: ${queryType}`);
  }

  const url = `https://${config.domain}/k/v1/records.json?` +
    `app=${config.appId}&totalCount=false&query=${encodeURIComponent(queryStr)}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'X-Cybozu-API-Token': config.apiToken },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`kintone API error: ${resp.status} ${text.substring(0, 200)}`);
  }

  const data = await resp.json();
  return (data.records || []).map(r => ({
    recordNumber: r['レコード番号']?.value || '',
    name: r['username']?.value || r['名前']?.value || '',
    price: parseInt(r['max_expensive_price']?.value || '0', 10) || 0,
  }));
}
