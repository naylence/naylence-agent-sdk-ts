# Naylence Agent SDK (Node.js) - Advanced Security Build

This Docker image provides the **Naylence Agent SDK** for Node.js with **Advanced Security** features, enabling developers to build enterprise-grade AI agents with enhanced security capabilities.

⚠️ **Mixed Licensing**: This image bundles components with different licenses.

## Quick Start

```bash
docker pull naylence/agent-sdk-adv-node:latest
docker run -it naylence/agent-sdk-adv-node:latest node --version
```

## Available Tags

- `latest` - Latest stable release
- `0.1.0`, `0.1`, `0` - Semantic version tags
- Specific versions (e.g., `0.1.0`)

## Usage

### Run Interactive Shell

```bash
docker run -it naylence/agent-sdk-adv-node:latest /bin/bash
```

### Use in Your Dockerfile

```dockerfile
FROM naylence/agent-sdk-adv-node:latest

WORKDIR /app
COPY . .

# Your agent code with advanced security features
CMD ["node", "your-secure-agent.js"]
```

### Volume Mounting

Mount your agent code into the container:

```bash
docker run -v $(pwd):/app -w /app naylence/agent-sdk-adv-node:latest node your-agent.js
```

## Image Details

- **Base Image**: `node:24-slim`
- **Node.js Version**: 24.x
- **Architecture**: `linux/amd64`, `linux/arm64`
- **User**: Non-root user (`agent`, UID 1000)
- **Working Directory**: `/app`

## Included Packages

1. **@naylence/agent-sdk** (Apache-2.0)
2. **@naylence/advanced-security** (BSL-1.1)

## Environment Variables

- `NODE_ENV=production` - Set to production mode
- `PATH` includes global npm packages

## Advanced Security Features

The `@naylence/advanced-security` package provides:
- Enhanced encryption and key management
- Advanced authentication mechanisms
- Enterprise security policies
- Audit logging and compliance features

## License

⚠️ **IMPORTANT**: This image contains components with different licenses:

- **@naylence/agent-sdk**: [Apache License 2.0](https://github.com/naylence/naylence-agent-sdk-ts/blob/main/LICENSE)
- **@naylence/advanced-security**: [Business Source License 1.1 (BSL-1.1)](https://github.com/naylence/naylence-advanced-security)

By using this image, you agree to comply with **all applicable license terms**.

### BSL-1.1 Summary

The Business Source License allows:
- ✅ Development and testing
- ✅ Non-production use
- ✅ Internal business use

Commercial production use may require a commercial license. See the [full license](https://github.com/naylence/naylence-advanced-security) for details.

### License Notice Location

License information is available in the container at:
```
/home/agent/licenses/NOTICE
```

## Links

- [GitHub Repository](https://github.com/naylence/naylence-agent-sdk-ts)
- [npm Package](https://www.npmjs.com/package/@naylence/agent-sdk)
- [Advanced Security Info](https://github.com/naylence/naylence-advanced-security)
- [Documentation](https://github.com/naylence/naylence-agent-sdk-ts#readme)

## Support

For issues and questions:
- GitHub Issues: https://github.com/naylence/naylence-agent-sdk-ts/issues
- Email: naylencedev@gmail.com

For commercial licensing inquiries:
- Email: naylencedev@gmail.com
