FROM node:24-slim

# Environment settings for production
ENV NODE_ENV=production

# Create non-root user first
RUN useradd -m -u 1000 agent

WORKDIR /app

# Switch to non-root user
USER agent

# Install the package globally for the user
ARG SDK_VERSION
RUN npm install -g --prefix /home/agent/.npm-global \
    @naylence/agent-sdk${SDK_VERSION:+@${SDK_VERSION}}

# Add npm global bin to PATH
ENV PATH="/home/agent/.npm-global/bin:$PATH"

CMD ["node", "--version"]
