// 领域与被测服务是不同维度；标识稳定，名称来自案例集参考。
const DOMAINS = Object.freeze({
  'materials-rd': '材料研发',
  'materials-rd-context': '材料研发上下文',
  'chip-packaging': '芯片封装',
  'computing-satellite-engineering': '算力卫星系统工程',
  'space-computing-packaging': '太空计算芯片与先进封装',
  'synthesis-preparation': '合成制备',
  'chip-packaging-interdisciplinary': '芯片封装跨学科科研',
  'space-computing-interdisciplinary': '太空计算跨学科科研',
  'computing-satellite-interdisciplinary': '算力卫星跨学科科研',
});

module.exports = { DOMAINS };
