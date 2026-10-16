// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * Aretia Launch, EVM: a fixed-supply token and the factory that makes it.
 *
 * The token (AretiaToken) is a plain ERC-20. It has NO owner, NO mint after construction, NO burn-by-admin, NO pause, NO
 * blacklist, NO fee on transfer and NO upgrade path. The whole supply is minted once, in the constructor, to the creator.
 *
 * The factory (AretiaTokenFactory) is immutable: no owner, no admin, no setters, no upgrade. Its flat creation fee and the
 * address that receives it are fixed when it is deployed. To change either, deploy a new factory; the page only trusts the
 * factory addresses written in its own code. A call must send exactly the fee, which is forwarded to the fee recipient in the
 * same transaction, so the factory never holds funds.
 */
contract AretiaToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public immutable totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 supply_, address creator_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        totalSupply = supply_;
        balanceOf[creator_] = supply_;
        emit Transfer(address(0), creator_, supply_);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            unchecked {
                allowance[from][msg.sender] = allowed - value;
            }
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(to != address(0), "to zero");
        uint256 bal = balanceOf[from];
        require(bal >= value, "balance");
        unchecked {
            balanceOf[from] = bal - value;
            balanceOf[to] += value; // cannot overflow: the sum of all balances is totalSupply
        }
        emit Transfer(from, to, value);
    }
}

contract AretiaTokenFactory {
    /** Where the creation fee goes. Fixed at deployment. */
    address public immutable feeRecipient;
    /** The exact amount of the chain's native coin a creation must send, in wei. Fixed at deployment. */
    uint256 public immutable fee;

    event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint8 decimals, uint256 supply);

    constructor(address feeRecipient_, uint256 fee_) {
        require(feeRecipient_ != address(0), "recipient");
        feeRecipient = feeRecipient_;
        fee = fee_;
    }

    /** Creates a token and mints its whole supply to the caller. Send exactly `fee`. */
    function create(string calldata name, string calldata symbol, uint8 decimals, uint256 supply) external payable returns (address token) {
        require(msg.value == fee, "fee");
        require(supply > 0, "supply");
        require(bytes(name).length > 0 && bytes(name).length <= 32, "name");
        require(bytes(symbol).length > 0 && bytes(symbol).length <= 11, "symbol");
        require(decimals <= 18, "decimals");
        token = address(new AretiaToken(name, symbol, decimals, supply, msg.sender));
        emit TokenCreated(token, msg.sender, name, symbol, decimals, supply);
        if (msg.value > 0) {
            (bool ok, ) = feeRecipient.call{value: msg.value}("");
            require(ok, "fee transfer");
        }
    }
}
