/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // 工廠現場（戴手套、單手操作）專用的大尺寸觸控工具
      minHeight: { touch: '48px' },
      boxShadow: {
        card: '0 2px 10px rgba(15, 23, 42, 0.08)',
      },
    },
  },
  plugins: [],
};
