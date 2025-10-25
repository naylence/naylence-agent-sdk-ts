FROM node:24-slim

# Environment settings for production
ENV NODE_ENV=production

# Create non-root user first
RUN useradd -m -u 1001 agent

# Create app directory and set ownership
RUN mkdir -p /app && chown -R agent:agent /app

WORKDIR /app

# Switch to non-root user
USER agent

# Install the package locally
ARG SDK_VERSION
RUN npm install @naylence/agent-sdk${SDK_VERSION:+@${SDK_VERSION}}

CMD ["node", "--version"]
