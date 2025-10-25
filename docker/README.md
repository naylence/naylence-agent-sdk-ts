# Naylence Agent SDK (Node.js) - Docker Image

This Docker image provides the **Naylence Agent SDK** for Node.js, enabling developers to build and deploy AI agents with minimal setup.

## Quick Start

```bash
docker pull naylence/agent-sdk-node:latest
docker run -it naylence/agent-sdk-node:latest node --version
```

## Available Tags

- `latest` - Latest stable release
- `0.1.0`, `0.1`, `0` - Semantic version tags
- Specific versions (e.g., `0.1.0`)

## Usage

### Run Interactive Shell

```bash
docker run -it naylence/agent-sdk-node:latest /bin/bash
```

### Use in Your Dockerfile

```dockerfile
FROM naylence/agent-sdk-node:latest

WORKDIR /app
COPY . .

# Your agent code here
CMD ["node", "your-agent.js"]
```

### Volume Mounting

Mount your agent code into the container:

```bash
docker run -v $(pwd):/app -w /app naylence/agent-sdk-node:latest node your-agent.js
```

## Image Details

- **Base Image**: `node:24-slim`
- **Node.js Version**: 24.x
- **Architecture**: `linux/amd64`, `linux/arm64`
- **User**: Non-root user (`agent`, UID 1000)
- **Working Directory**: `/app`

## Environment Variables

- `NODE_ENV=production` - Set to production mode
- `PATH` includes global npm packages

## Package Installation

The image includes `@naylence/agent-sdk` installed globally, accessible from anywhere in the container.

## License

Apache-2.0

## Links

- [GitHub Repository](https://github.com/naylence/naylence-agent-sdk-ts)
- [npm Package](https://www.npmjs.com/package/@naylence/agent-sdk)
- [Documentation](https://github.com/naylence/naylence-agent-sdk-ts#readme)

## Support

For issues and questions:
- GitHub Issues: https://github.com/naylence/naylence-agent-sdk-ts/issues
- Email: naylencedev@gmail.com
