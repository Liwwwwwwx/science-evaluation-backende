function isSupportedComparisonPair(keys) {
  return Array.isArray(keys) && keys.length === 2 && keys.includes('alloy') && keys.includes('alpha-rsi');
}

module.exports = { isSupportedComparisonPair };
