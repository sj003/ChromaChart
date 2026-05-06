const PALETTE = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6'
];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this._chart = null;
  }

  render(queryResult, spec) {
    if (this._chart) { this._chart.destroy(); this._chart = null; }

    const { labels, values } = queryResult;
    this._chart = new Chart(this.canvas, this._config(labels, values, spec));
    return this._chart;
  }

  _config(labels, values, spec) {
    const isArea  = spec.type === 'area';
    const isPie   = spec.type === 'pie';
    const isLine  = spec.type === 'line' || isArea;
    const chartType = isPie ? 'pie' : isLine ? 'line' : 'bar';

    const colors = isPie || !isLine
      ? labels.map((_, i) => PALETTE[i % PALETTE.length])
      : PALETTE[0];

    const dataset = {
      label: spec.y?.label || 'Count',
      data: values,
      backgroundColor: isLine ? this._rgba(PALETTE[0], 0.12) : colors,
      borderColor: isLine ? PALETTE[0] : (isPie ? colors : colors),
      borderWidth: isLine ? 2.5 : 1,
      fill: isArea,
      tension: 0.35,
      pointRadius: isLine ? 3 : 0,
      pointHoverRadius: isLine ? 6 : 0,
      hoverOffset: isPie ? 8 : 0,
    };

    return {
      type: chartType,
      data: { labels, datasets: [dataset] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        plugins: {
          legend: { display: isPie, position: 'bottom', labels: { padding: 16, font: { size: 12 } } },
          title: {
            display: !!spec.title,
            text: spec.title || '',
            font: { size: 15, weight: '600', family: 'Inter, sans-serif' },
            color: '#1e293b',
            padding: { bottom: 20 }
          },
          tooltip: {
            backgroundColor: 'rgba(15,23,42,0.9)',
            titleFont: { size: 12 },
            bodyFont:  { size: 13 },
            padding: 10,
            callbacks: {
              label: ctx => `  ${ctx.label}: ${ctx.formattedValue}`
            }
          }
        },
        scales: isPie ? {} : {
          x: {
            grid: { color: 'rgba(0,0,0,0.04)', drawBorder: false },
            ticks: { maxRotation: 42, font: { size: 11 }, maxTicksLimit: 24, color: '#64748b' }
          },
          y: {
            grid: { color: 'rgba(0,0,0,0.04)', drawBorder: false },
            beginAtZero: true,
            ticks: { font: { size: 11 }, color: '#64748b' }
          }
        }
      }
    };
  }

  _rgba(hex, a) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  destroy() {
    if (this._chart) { this._chart.destroy(); this._chart = null; }
  }
}
