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
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/__tests__/**', '!src/**/index.ts'],
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
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  testTimeout: 30000,
  maxWorkers: 1
};
