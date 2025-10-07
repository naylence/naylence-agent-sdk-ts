/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.[tj]s$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.jest.json',
        useESM: true
      }
    ]
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/index.ts',
    '!src/browser.ts',
    '!src/naylence/agent/configs.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageProvider: 'v8',
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  extensionsToTreatAsEsm: ['.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!(@noble|jose)/)',
    '<rootDir>/../naylence-(core|factory|runtime)-ts/dist/',
    '../naylence-(core|factory|runtime)-ts/dist/'
  ],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^naylence-core$': '<rootDir>/../naylence-core-ts/dist/cjs/index.js',
    '^naylence-factory$': '<rootDir>/../naylence-factory-ts/dist/cjs/index.js',
    '^naylence-runtime$': '<rootDir>/../naylence-runtime-ts/dist/cjs/index.js'
  },
  testTimeout: 30000,
  maxWorkers: 1
};
