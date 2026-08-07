const XLSX = require('xlsx')

function toXlsx(sheets) {
  const wb = XLSX.utils.book_new()
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet([s.header, ...s.rows])
    if (s.cols) ws['!cols'] = s.cols.map(w => ({ wch: w }))
    ws['!freeze'] = { xSplit: 0, ySplit: 1 }
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31))
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

module.exports = { toXlsx }
